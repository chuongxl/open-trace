#!/bin/bash
export LOG=/tmp/ot-run.log
echo "RUNNER START $(date)" > $LOG
echo "=== 1. CLONE ===" >> $LOG
cd /Users/chuongnd/github 2>>$LOG || exit 1
rm -rf ot-p3
git clone --branch feat/phase-3-opencode-watcher https://chuongxl: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@github.com/chuongxl/open-trace.git ot-p3 2>>$LOG
echo "clone_exit=$?" >> $LOG
cd ot-p3 2>>$LOG || exit 1
echo '=== 2. OPENDCODE SCHEMA DUMP ===' >> $LOG
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
cat /tmp/oc-dump.txt >> $LOG
echo '=== 3. NPM INSTALL ===' >> $LOG
npm install --no-audit --no-fund 2>&1 | tail -3 >> $LOG
echo '=== 4. DAEMON ===' >> $LOG
pkill -f 'node daemon/index.js' 2>/dev/null
nohup node daemon/index.js > /tmp/ot-daemon.log 2>&1 &
sleep 6
cat /tmp/ot-daemon.log >> $LOG
echo '=== 5. HEALTH ===' >> $LOG
curl -s http://127.0.0.1:9900/api/health >> $LOG
echo '' >> $LOG
echo '=== 6. OT DB ===' >> $LOG
sqlite3 ~/.open-trace/data.db '.tables' >> $LOG 2>&1
sqlite3 ~/.open-trace/data.db "SELECT (SELECT COUNT(*) FROM sessions) || ' sessions, ' || (SELECT COUNT(*) FROM prompts) || ' prompts, ' || (SELECT COUNT(*) FROM tool_calls) || ' tool_calls'" >> $LOG 2>&1
sqlite3 ~/.open-trace/data.db 'SELECT id, tool, project_name, total_input_tokens, total_output_tokens, equiv_cost_usd FROM sessions LIMIT 5' >> $LOG 2>&1
sqlite3 ~/.open-trace/data.db 'SELECT id, session_id, model, input_tokens, output_tokens, substr(input_text,1,60) FROM prompts LIMIT 5' >> $LOG 2>&1
sqlite3 ~/.open-trace/data.db 'SELECT id, prompt_id, call_type, name, substr(input,1,60) FROM tool_calls LIMIT 5' >> $LOG 2>&1
echo '=== 7. PUSH RESULTS ===' >> $LOG
B64=$(base64 < $LOG | tr -d "
")
curl -s -X PUT -H "Authorization: token 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" -H "Content-Type: application/json" -d '{"message":"tmp: runner results","content":"'$B64'","branch":"feat/phase-3-opencode-watcher"}' https://api.github.com/repos/chuongxl/open-trace/contents/tmp/runner-results.txt >> $LOG 2>&1
echo '' >> $LOG
echo 'RUNNER_DONE' >> $LOG