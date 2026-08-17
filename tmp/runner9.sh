#!/bin/bash
# Phase 3 automated integration test — runner9 (proven runner4 pattern)
export LOG=/tmp/ot-run9.log
echo "=== INTEGRATION TEST $(date) ===" > $LOG
export GHTOK=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
cd /tmp/ot9
echo "--- GIT LOG ---" >> $LOG
git log --oneline -3 2>/dev/null >> $LOG
[ -d node_modules ] || npm install --no-audit --no-fund 2>&1 | tail -2 >> $LOG
echo "--- NPM TEST (integration suite) ---" >> $LOG
npm test 2>&1 | tail -40 >> $LOG
echo "--- DAEMON HEALTH (real DB smoke) ---" >> $LOG
pkill -f "node daemon/index.js" 2>/dev/null; sleep 1
OPENCODE_DB_PATH="$HOME/.local/share/opencode/opencode.db" DB_PATH="$HOME/.open-trace/data.db" nohup node daemon/index.js > /tmp/ot-daemon9.log 2>&1 &
sleep 6
curl -s http://127.0.0.1:9900/api/health >> $LOG; echo "" >> $LOG
cat /tmp/ot-daemon9.log | tail -8 >> $LOG
echo "--- OT DB COUNTS ---" >> $LOG
sqlite3 "$HOME/.open-trace/data.db" "SELECT (SELECT COUNT(*) FROM sessions)||' sessions, '||(SELECT COUNT(*) FROM prompts)||' prompts, '||(SELECT COUNT(*) FROM tool_calls)||' tool_calls'" >> $LOG 2>&1
sqlite3 "$HOME/.open-trace/data.db" "SELECT id, tool, model, total_input_tokens, total_output_tokens, equiv_cost_usd FROM sessions LIMIT 3" >> $LOG 2>&1
pkill -f "node daemon/index.js" 2>/dev/null
B64=$(base64 < $LOG | tr -d '\n')
curl -s -X PUT -H "Authorization: token $GHTOK" -H "Content-Type: application/json" -d '{"message":"tmp: p6 integration results","content":"'$B64'","branch":"feat/phase-3-opencode-watcher"}' https://api.github.com/repos/chuongxl/open-trace/contents/tmp/p6-results.txt >> $LOG 2>&1
echo "" >> $LOG
echo "RUNNER9_DONE" >> $LOG