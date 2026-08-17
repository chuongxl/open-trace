#!/bin/bash
set -e
cd /tmp
rm -rf ot-test
git clone -q --branch feat/phase-3-opencode-watcher https://chuongxl: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@github.com/chuongxl/open-trace.git ot-test
cd /tmp/ot-test
npm install --no-audit --no-fund 2>&1 | tail -1
R=/tmp/ot-run7.txt; rm -f $R
npm test 2>&1 | tee $R | tail -30
echo "EXIT=$?" >> $R
b64=$(base64 -i $R | tr -d "\n")
curl -s -X PUT -H "Authorization: token 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" -H "Content-Type: application/json" -d "{\"message\":\"runner7 results\",\"branch\":\"feat/phase-3-opencode-watcher\",\"content\":\"$b64\"}" "https://api.github.com/repos/chuongxl/open-trace/contents/tmp/p6-results.txt" > /dev/null
echo PUBLISHED