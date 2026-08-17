#!/bin/bash
# Phase 3 manual-test runner — run from repo root: bash tmp/runner3.sh
set -x
export LOG=/tmp/ot-run3.log
echo "=== PHASE 3 TEST $(date) ===" > $LOG

# 1. Branch + install
git fetch -q origin
git checkout -q feat/phase-3-opencode-watcher 2>>$LOG
git pull -q origin feat/phase-3-opencode-watcher 2>>$LOG
[ -d node_modules ] || npm install --no-audit --no-fund 2>&1 | tail -2 >> $LOG

# 2. Kill old daemon, start fresh
pkill -f 'node daemon/index.js' 2>/dev/null
sleep 1
nohup node daemon/index.js > /tmp/ot-daemon.log 2>&1 &
sleep 6
echo '--- DAEMON LOG ---' >> $LOG
cat /tmp/ot-daemon.log >> $LOG

# 3. Health
echo '--- HEALTH ---' >> $LOG
curl -s http://127.0.0.1:9900/api/health >> $LOG
echo '' >> $LOG

# 4. OpenCode schema ground truth
echo '--- OPENCODE SCHEMA ---' >> $LOG
sqlite3 /Users/chuongnd/.local/share/opencode/opencode.db '.tables' >> $LOG 2>&1
echo '--- SESSION SAMPLE ---' >> $LOG
sqlite3 /Users/chuongnd/.local/share/opencode/opencode.db "SELECT id, title, model, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, cost, time_created FROM session ORDER BY time_created DESC LIMIT 3" >> $LOG 2>&1
echo '--- MESSAGE SAMPLE ---' >> $LOG
sqlite3 /Users/chuongnd/.local/share/opencode/opencode.db "SELECT id, session_id, substr(data,1,200) FROM message ORDER BY time_created DESC LIMIT 3" >> $LOG 2>&1
echo '--- PART SAMPLE ---' >> $LOG
sqlite3 /Users/chuongnd/.local/share/opencode/opencode.db "SELECT id, message_id, substr(data,1,200) FROM part ORDER BY time_created DESC LIMIT 5" >> $LOG 2>&1

# 5. open-trace state
echo '--- OT DB ---' >> $LOG
sqlite3 /Users/chuongnd/.open-trace/data.db '.tables' >> $LOG 2>&1
echo '--- OT COUNTS ---' >> $LOG
sqlite3 /Users/chuongnd/.open-trace/data.db "SELECT (SELECT COUNT(*) FROM sessions) || ' sessions, ' || (SELECT COUNT(*) FROM prompts) || ' prompts, ' || (SELECT COUNT(*) FROM tool_calls) || ' tool_calls'" >> $LOG 2>&1
echo '--- OT SESSIONS ---' >> $LOG
sqlite3 /Users/chuongnd/.open-trace/data.db "SELECT id, tool, project_name, model, total_input_tokens, total_output_tokens, equiv_cost_usd FROM sessions LIMIT 5" >> $LOG 2>&1
echo '--- OT PROMPTS ---' >> $LOG
sqlite3 /Users/chuongnd/.open-trace/data.db "SELECT id, session_id, substr(model,1,30), substr(input_text,1,60) FROM prompts LIMIT 5" >> $LOG 2>&1
echo '--- OT TOOL CALLS ---' >> $LOG
sqlite3 /Users/chuongnd/.open-trace/data.db "SELECT id, prompt_id, call_type, name, substr(input,1,40) FROM tool_calls LIMIT 5" >> $LOG 2>&1

# 6. Push results to branch
cp $LOG tmp/phase3-test-results.txt 2>/dev/null
git -c user.email=chuongxl@users.noreply.github.com -c user.name=chuongxl add tmp/phase3-test-results.txt
git -c user.email=chuongxl@users.noreply.github.com -c user.name=chuongxl commit -m 'tmp: phase 3 test results' -q
git push -q origin feat/phase-3-opencode-watcher 2>&1 | tail -2 >> $LOG
echo 'RUNNER3_DONE' >> $LOG
