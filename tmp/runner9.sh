#!/bin/bash
# Phase 3 integration test - runner9 self-contained
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export LOG=/tmp/ot-run9.log
echo "=== INTEGRATION TEST $(date) ===" > $LOG
export GHTOK=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
cd /tmp && rm -rf ot9
git clone -q --branch feat/phase-3-opencode-watcher https://chuongxl:$GHTOK@github.com/chuongxl/open-trace.git ot9 >> $LOG 2>&1
echo "clone=$?" >> $LOG
cd ot9
[ -d node_modules ] || npm install --no-audit --no-fund 2>&1 | tail -2 >> $LOG
echo "--- NPM TEST ---" >> $LOG
npm test 2>&1 | tail -40 >> $LOG
echo "--- DAEMON HEALTH ---" >> $LOG
pkill -f "node daemon/index.js" 2>/dev/null; sleep 1
DB_PATH="$HOME/.open-trace/data.db" nohup node daemon/index.js > /tmp/ot-daemon9.log 2>&1 &
sleep 6
curl -s http://127.0.0.1:9900/api/health >> $LOG; echo "" >> $LOG
cat /tmp/ot-daemon9.log | tail -6 >> $LOG
pkill -f "node daemon/index.js" 2>/dev/null
B64=$(base64 < $LOG | tr -d "
")
curl -s -X PUT -H "Authorization: token $GHTOK" -H "Content-Type: application/json" -d '{"message":"tmp: p6 integration results","content":"'$B64'","branch":"feat/phase-3-opencode-watcher"}' https://api.github.com/repos/chuongxl/open-trace/contents/tmp/p7-results.txt >> $LOG 2>&1
echo "" >> $LOG
echo "RUNNER9_DONE" >> $LOG