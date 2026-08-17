#!/bin/bash
set -u
cd "$(dirname "$0")/.."
echo "=== open-trace integration test (runner8) $(date) ==="
npm install --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund 2>&1 | tail -5
npm test 2>&1 | tee /tmp/ot-test-out.txt | tail -40
cp /tmp/ot-test-out.txt tmp/p6-results.txt
git add tmp/p6-results.txt
git -c user.email=agent@open-trace -c user.name="OpenTrace Agent" commit -qm "test: publish p6 results (runner8)" || true
git push -q origin feat/phase-3-opencode-watcher 2>&1 | tail -2
echo "=== published ==="