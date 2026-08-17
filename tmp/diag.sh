#!/bin/bash
cd /Users/chuongnd/github/ot-p4
echo "BRANCH: $(git rev-parse --abbrev-ref HEAD 2>&1)"
echo "HEAD: $(git log --oneline -1 2>&1)"
echo "REMOTE: $(git remote get-url origin 2>&1)"
echo "TESTSCRIPT: $(grep -A1 test package.json | head -2 | tr "\n" " ")"
echo "TESTSDIR: $(ls -la tests 2>&1 | head -5 | tr "\n" " ")"
echo "GITSTATUS: $(git status --short 2>&1 | head -3 | tr "\n" " ")"
b64=$(cat /tmp/ot-diag.txt 2>/dev/null; echo __END__)
echo "DIAG-DONE"