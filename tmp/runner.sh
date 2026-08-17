#!/bin/bash
set -x
export GIT_SSH_COMMAND='ssh -o StrictHostKeyChecking=accept-new'
export GHTOK=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
cd /Users/chuongnd/github
rm -rf ot-p3
git clone --branch feat/phase-3-opencode-watcher git@github.com:chuongxl/open-trace.git ot-p3 2>&1 | tail -2
cd ot-p3
python3 << 'PYEOF' > /tmp/oc-dump.txt 2>&1
import sqlite3, json
out = []
def add(s): out.append(str(s))
try:
    oc = sqlite3.connect('/Users/chuongnd/.local/share/opencode/opencode.db')
    add('OC-TABLES: ' + ', '.join(r[0] for r in oc.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")))
    for t in ('session','message','part'):
        cols = [c[1] for c in oc.execute('PRAGMA table_info('+t+')')]
        add(t.upper()+'-COLS: ' + ', '.join(cols))
        for r in oc.execute('SELECT * FROM '+t+' LIMIT 2'):
            for c, v in zip(cols, r):
                s = str(v)
                add('  '+c+' = ' + (s[:200] if len(s)>200 else s))
    oc.close()
except Exception as e:
    add('OC-ERR: ' + repr(e))
print(chr(10).join(out))
PYEOF
cat /tmp/oc-dump.txt
npm install 2>&1 | tail -2
pkill -f 'node daemon/index.js' 2>/dev/null
nohup node daemon/index.js > /tmp/ot-daemon.log 2>&1 &
sleep 5
echo '--- DAEMON LOG ---'
cat /tmp/ot-daemon.log
echo '--- HEALTH ---'
curl -s http://127.0.0.1:9900/api/health
echo ''
echo '--- OT DB TABLES ---'
sqlite3 ~/.open-trace/data.db '.tables'
echo '--- OT COUNTS ---'
sqlite3 ~/.open-trace/data.db "SELECT (SELECT COUNT(*) FROM sessions) || ' sessions, ' || (SELECT COUNT(*) FROM prompts) || ' prompts'"
mkdir -p /tmp/ot-results
cp /tmp/oc-dump.txt /tmp/ot-results/schema.txt
cp /tmp/ot-daemon.log /tmp/ot-results/daemon.log
curl -s http://127.0.0.1:9900/api/health > /tmp/ot-results/health.txt
sqlite3 ~/.open-trace/data.db '.tables' > /tmp/ot-results/tables.txt
sqlite3 ~/.open-trace/data.db 'SELECT id, tool, project_name, total_input_tokens, total_output_tokens, equiv_cost_usd FROM sessions' > /tmp/ot-results/sessions.txt
sqlite3 ~/.open-trace/data.db 'SELECT id, session_id, model, input_tokens, output_tokens, substr(input_text,1,80) FROM prompts' > /tmp/ot-results/prompts.txt
sqlite3 ~/.open-trace/data.db 'SELECT id, prompt_id, call_type, name, substr(input,1,80) FROM tool_calls' > /tmp/ot-results/toolcalls.txt
cd /Users/chuongnd/github/ot-p3
cp /tmp/ot-results/*.txt tmp/ 2>/dev/null
git config user.email 'chuongxl@users.noreply.github.com'
git config user.name 'chuongxl'
git add tmp/ 2>&1
git commit -m "tmp: test results" 2>&1 | tail -1
git push origin feat/phase-3-opencode-watcher 2>&1 | tail -1
echo 'RUNNER_DONE'