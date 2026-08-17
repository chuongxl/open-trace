import sqlite3, json, base64, urllib.request as req, traceback, os
out = []
def add(s): out.append(str(s))
try:
    oc = sqlite3.connect('/Users/chuongnd/.local/share/opencode/opencode.db')
    add('OC-TABLES: ' + ', '.join(r[0] for r in oc.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")))
except Exception as e:
    add('OC-CONNECT-ERR: ' + traceback.format_exc())
try:
    for t in ('session','message','part'):
        cols = [c[1] for c in oc.execute('PRAGMA table_info('+t+')')]
        add(t.upper()+'-COLS: ' + ', '.join(cols))
        for r in oc.execute('SELECT * FROM '+t+' LIMIT 2'):
            for c, v in zip(cols, r):
                s = str(v)
                add('  '+c+' = ' + (s[:150] if len(s)>150 else s))
    oc.close()
except Exception as e:
    add('OC-READ-ERR: ' + traceback.format_exc())
try:
    ot = sqlite3.connect('/Users/chuongnd/.open-trace/data.db')
    add('OT-TABLES: ' + ', '.join(r[0] for r in ot.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")))
    for t in ('sessions','prompts','tool_calls'):
        add('OT-'+t+'-COUNT: ' + str(ot.execute('SELECT COUNT(*) FROM '+t).fetchone()[0]))
    ot.close()
except Exception as e:
    add('OT-ERR: ' + traceback.format_exc())
try:
    add('--- DAEMON LOG ---')
    add(open('/tmp/ot-test.log').read()[-2000:])
except Exception as e:
    add('LOG-ERR: ' + str(e))
content = chr(10).join(out)
open('/Users/chuongnd/github/ot-p3/tmp/last-dump.txt','w').write(content)
open('/tmp/last-dump.txt','w').write(content)
for path in ('tmp/ot-dump.txt',):
    body = json.dumps({'message':'tmp: dump','content':base64.b64encode(content.encode()).decode(),'branch':'feat/phase-3-opencode-watcher'}).encode()
    req.urlopen(req.Request('https://api.github.com/repos/chuongxl/open-trace/contents/'+path, body, {'Authorization':'token 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','Content-Type':'application/json'}, method='PUT'))
print('OK-BYTES=' + str(len(content)))