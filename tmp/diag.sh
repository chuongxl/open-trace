#!/bin/bash
cd /Users/chuongnd/github/ot-p4 2>/dev/null || git clone -q --branch feat/phase-3-opencode-watcher https://chuongxl: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@github.com/chuongxl/open-trace.git /Users/chuongnd/github/ot-p4
cd /Users/chuongnd/github/ot-p4
git fetch -q origin 2>&1; git reset --hard -q origin/feat/phase-3-opencode-watcher 2>&1 | tail -1
R=/tmp/ot-diag.txt; rm -f $R
echo "BRANCH: $(git rev-parse --abbrev-ref HEAD)" >> $R
echo "HEAD: $(git log --oneline -1)" >> $R
echo "PACKAGE_TEST: $(grep -A2 test package.json | tr "\n" " ")" >> $R
echo "FILES: $(ls tests 2>&1 | tr "\n" " ")" >> $R
npm install --no-audit --no-fund 2>&1 | tail -1 >> $R
node --test tests/*.test.mjs 2>&1 | tail -30 >> $R
b64=$(base64 -i $R | tr -d "\n")
curl -s -X PUT -H "Authorization: token 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" -H "Content-Type: application/json" -d "{\"message\":\"diag results\",\"branch\":\"feat/phase-3-opencode-watcher\",\"content\":\"$b64\"}" "https://api.github.com/repos/chuongxl/open-trace/contents/tmp/diag-results.txt" > /dev/null
echo DIAG_DONE