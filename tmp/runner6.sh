#!/bin/bash
set -e
cd /Users/chuongnd/github/ot-p4 2>/dev/null || git clone -q --branch feat/phase-3-opencode-watcher git@github.com:chuongxl/open-trace.git /Users/chuongnd/github/ot-p4
cd /Users/chuongnd/github/ot-p4
git fetch -q origin && git checkout -q feat/phase-3-opencode-watcher && git pull -q origin feat/phase-3-opencode-watcher 2>&1 | tail -1
npm install --no-audit --no-fund 2>&1 | tail -2
rm -f /tmp/ot-p6.log
npm test 2>&1 | tee /tmp/ot-p6.log | tail -40
echo "EXIT=$?" >> /tmp/ot-p6.log
b64=$(base64 -i /tmp/ot-p6.log | tr -d "\n")
curl -s -X PUT -H "Authorization: token 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" -H "Content-Type: application/json" -d "{\"message\":\"test results\",\"branch\":\"feat/phase-3-opencode-watcher\",\"content\":\"$b64\"}" "https://api.github.com/repos/chuongxl/open-trace/contents/tmp/p6-results.txt" > /dev/null
echo PUBLISH_DONE