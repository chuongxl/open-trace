#!/bin/bash
export LOG=/tmp/ot-run5.log
echo "=== PHASE 3 DEEP PROBE $(date) ===" > $LOG
export GHTOK=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
export DIR=/Users/chuongnd/github/ot-p5
rm -rf $DIR
git clone --quiet --branch feat/phase-3-opencode-watcher https://chuongxl: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@github.com/chuongxl/open-trace.git $DIR 2>>$LOG
echo "clone=$?" >> $LOG
cd $DIR
[ -d node_modules ] || npm install --no-audit --no-fund 2>&1 | tail -1 >> $LOG
echo '--- OPENCODE VERSION ---' >> $LOG
which opencode >> $LOG 2>&1
opencode --version >> $LOG 2>&1
echo '--- ROW COUNTS PER TABLE ---' >> $LOG
for t in session message part session_message session_input project workspace; do
  echo -n "$t: " >> $LOG
  sqlite3 /Users/chuongnd/.local/share/opencode/opencode.db "SELECT COUNT(*) FROM $t" >> $LOG 2>&1
done
echo '--- SESSION SCHEMA ---' >> $LOG
sqlite3 /Users/chuongnd/.local/share/opencode/opencode.db "PRAGMA table_info(session)" >> $LOG 2>&1
echo '--- SESSION_MESSAGE SCHEMA ---' >> $LOG
sqlite3 /Users/chuongnd/.local/share/opencode/opencode.db "PRAGMA table_info(session_message)" >> $LOG 2>&1
echo '--- SESSION_MESSAGE SAMPLE ---' >> $LOG
sqlite3 /Users/chuongnd/.local/share/opencode/opencode.db "SELECT * FROM session_message LIMIT 2" >> $LOG 2>&1
echo '--- SESSION INPUT SAMPLE ---' >> $LOG
sqlite3 /Users/chuongnd/.local/share/opencode/opencode.db "SELECT * FROM session_input LIMIT 2" >> $LOG 2>&1
echo '--- MESSAGE/EVENT SAMPLE ---' >> $LOG
sqlite3 /Users/chuongnd/.local/share/opencode/opencode.db "SELECT id, session_id, substr(data,1,300) FROM message LIMIT 2" >> $LOG 2>&1
echo '--- EVENT SAMPLE ---' >> $LOG
sqlite3 /Users/chuongnd/.local/share/opencode/opencode.db "SELECT id, session_id, type, substr(data,1,200) FROM event LIMIT 2" >> $LOG 2>&1
pkill -f 'node daemon/index.js' 2>/dev/null
sleep 1
nohup node daemon/index.js > /tmp/ot-daemon.log 2>&1 &
sleep 6
echo '--- DAEMON LOG ---' >> $LOG
cat /tmp/ot-daemon.log >> $LOG
B64=$(base64 < $LOG | tr -d '
')
curl -s -X PUT -H "Authorization: token $GHTOK" -H "Content-Type: application/json" -d '{"message":"tmp: p5 probe","content":"'$B64'","branch":"feat/phase-3-opencode-watcher"}' https://api.github.com/repos/chuongxl/open-trace/contents/tmp/p5-probe.txt >> $LOG 2>&1
echo 'RUNNER5_DONE' >> $LOG
