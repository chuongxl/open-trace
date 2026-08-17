#!/bin/bash
LOG=/tmp/ot-run6.log
echo "=== PHASE 3 TEST 6 $(date) ===" > $LOG
cd "$(dirname "$0")/.."
echo "pwd=$(pwd)" >> $LOG
[ -d node_modules ] || npm install --no-audit --no-fund 2>&1 | tail -1 >> $LOG
echo "--- OPENCODE BIN ---" >> $LOG
command -v opencode >> $LOG 2>&1
opencode --version >> $LOG 2>&1 || echo "opencode not found" >> $LOG
DB=~/.local/share/opencode/opencode.db
echo "--- ROW COUNTS ---" >> $LOG
for t in session message part session_message session_input session_context_epoch session_share project project_directory workspace account event; do
  printf "%-24s " "$t" >> $LOG
  sqlite3 "$DB" "SELECT COUNT(*) FROM $t" >> $LOG 2>&1
done
echo "--- SESSION SCHEMA ---" >> $LOG
sqlite3 "$DB" "PRAGMA table_info(session)" >> $LOG 2>&1
echo "--- MESSAGE SCHEMA ---" >> $LOG
sqlite3 "$DB" "PRAGMA table_info(message)" >> $LOG 2>&1
echo "--- PART SCHEMA ---" >> $LOG
sqlite3 "$DB" "PRAGMA table_info(part)" >> $LOG 2>&1
echo "--- SESSION_MESSAGE SCHEMA ---" >> $LOG
sqlite3 "$DB" "PRAGMA table_info(session_message)" >> $LOG 2>&1
echo "--- SESSION MESSAGE SAMPLE ---" >> $LOG
sqlite3 "$DB" "SELECT id, session_id, parent_id, url, substr(data,1,150) FROM session_message LIMIT 3" >> $LOG 2>&1
echo "--- SESSION SAMPLE ---" >> $LOG
sqlite3 "$DB" "SELECT id, directory, model, tokens_input, tokens_output, cost, time_created FROM session LIMIT 3" >> $LOG 2>&1
echo "--- MESSAGE SAMPLE ---" >> $LOG
sqlite3 "$DB" "SELECT id, session_id, substr(data,1,150) FROM message LIMIT 3" >> $LOG 2>&1
echo "--- PART SAMPLE ---" >> $LOG
sqlite3 "$DB" "SELECT id, message_id, substr(data,1,150) FROM part LIMIT 3" >> $LOG 2>&1
pkill -f "node daemon/index.js" 2>/dev/null; sleep 1
nohup node daemon/index.js > /tmp/ot-daemon.log 2>&1 &
sleep 8
echo "--- DAEMON LOG ---" >> $LOG
cat /tmp/ot-daemon.log >> $LOG 2>&1
echo "--- HEALTH ---" >> $LOG
curl -s http://127.0.0.1:9900/api/health >> $LOG 2>&1; echo >> $LOG
echo "--- OT DB ---" >> $LOG
sqlite3 ~/.open-trace/data.db ".tables" >> $LOG 2>&1
echo "--- OT COUNTS ---" >> $LOG
for t in prompts sessions tool_calls; do
  printf "%-12s " "$t" >> $LOG
  sqlite3 ~/.open-trace/data.db "SELECT COUNT(*) FROM $t" >> $LOG 2>&1
done
echo "--- OT SESSIONS ---" >> $LOG
sqlite3 ~/.open-trace/data.db "SELECT id, tool, project_name, model, total_input_tokens, total_output_tokens, equiv_cost_usd FROM sessions ORDER BY rowid DESC LIMIT 5" >> $LOG 2>&1
echo "--- OT PROMPTS ---" >> $LOG
sqlite3 ~/.open-trace/data.db "SELECT id, session_id, model, input_tokens, output_tokens, substr(input_text,1,80) FROM prompts ORDER BY rowid DESC LIMIT 5" >> $LOG 2>&1
B64=$(base64 < $LOG | tr -d "\n")
curl -s -X PUT -H "Authorization: token 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" -H "Content-Type: application/json" -d "{\"message\":\"tmp: p6 results\",\"content\":\"$B64\",\"branch\":\"feat/phase-3-opencode-watcher\"}" https://api.github.com/repos/chuongxl/open-trace/contents/tmp/p6-results.txt >> $LOG 2>&1
echo "P6_DONE=$?" >> $LOG