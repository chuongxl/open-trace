#!/bin/bash
# Phase 3 self-contained test — no git push needed, publishes via curl
export LOG=/tmp/ot-run4.log
echo "=== PHASE 3 TEST $(date) ===" > $LOG
export GHTOK=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
export DIR=/Users/chuongnd/github/ot-p4
rm -rf $DIR
git clone --quiet --branch feat/phase-3-opencode-watcher https://chuongxl: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@github.com/chuongxl/open-trace.git $DIR 2>>$LOG
echo "clone=$?" >> $LOG
cd $DIR
[ -d node_modules ] || npm install --no-audit --no-fund 2>&1 | tail -1 >> $LOG
pkill -f 'node daemon/index.js' 2>/dev/null
sleep 1
nohup node daemon/index.js > /tmp/ot-daemon.log 2>&1 &
sleep 6
echo '--- DAEMON LOG ---' >> $LOG
cat /tmp/ot-daemon.log >> $LOG
echo '--- HEALTH ---' >> $LOG
curl -s http://127.0.0.1:9900/api/health >> $LOG
echo '' >> $LOG
echo '--- OPENCODE SCHEMA ---' >> $LOG
sqlite3 /Users/chuongnd/.local/share/opencode/opencode.db '.tables' >> $LOG 2>&1
echo '--- SESSION SAMPLE ---' >> $LOG
sqlite3 /Users/chuongnd/.local/share/opencode/opencode.db "SELECT id, title, model, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, cost, time_created FROM session ORDER BY time_created DESC LIMIT 3" >> $LOG 2>&1
echo '--- MESSAGE SAMPLE ---' >> $LOG
sqlite3 /Users/chuongnd/.local/share/opencode/opencode.db "SELECT id, session_id, substr(data,1,200) FROM message ORDER BY time_created DESC LIMIT 3" >> $LOG 2>&1
echo '--- PART SAMPLE ---' >> $LOG
sqlite3 /Users/chuongnd/.local/share/opencode/opencode.db "SELECT id, message_id, substr(data,1,200) FROM part ORDER BY time_created DESC LIMIT 5" >> $LOG 2>&1
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
# Publish via GitHub API (contents PUT with token) — no git auth needed
B64=$(base64 < $LOG | tr -d '
')
curl -s -X PUT -H "Authorization: token $GHTOK" -H "Content-Type: application/json" -d '{"message":"tmp: p3 results","content":"'$B64'","branch":"feat/phase-3-opencode-watcher"}' https://api.github.com/repos/chuongxl/open-trace/contents/tmp/p3-results.txt >> $LOG 2>&1
echo '' >> $LOG
echo 'RUNNER4_DONE' >> $LOG
