import sqlite3, json, base64, urllib.request as req, time
out = []
def add(s): out.append(s)
oc = sqlite3.connect('/Users/chuongnd/.local/share/opencode/opencode.db')
add('TABLES: ' + ', '.join(r[0] for r in oc.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")))
for t in ('session','message','part'):
    cols = [c[1] for c in oc.execute('PRAGMA table_info('+t+')')]
    add(t.upper()+' COLS: ' + ', '.join(cols))
    rows = oc.execute('SELECT * FROM '+t+' LIMIT 3').fetchall()
    for r in rows:
        for c, v in zip(cols, r):
            s = str(v)
            add(t[0].upper()+'.'+c+' = ' + (s[:180] if len(s)>180 else s))
oc.close()
ot = sqlite3.connect('/Users/chuongnd/.open-trace/data.db')
add('OT TABLES: ' + ', '.join(r[0] for r in ot.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")))
for t in ('sessions','prompts','tool_calls'):
    try: add('OT '+t+': ' + str(ot.execute('SELECT COUNT(*) FROM '+t).fetchone()[0]))
    except Exception as e: add('OT '+t+' err: '+str(e))
ot.close()
try: add('--- LOG TAIL ---'); add(open('/tmp/ot-p3.log').read()[-3000:])
except Exception as e: add('log err: '+str(e))
content = chr(10).join(out)
path = 'tmp/ot-dump-' + str(int(time.time())) + '.txt'
b64 = base64.b64encode(content.encode()).decode()
body = json.dumps({'message':'tmp: schema dump','content':b64,'branch':'feat/phase-3-opencode-watcher'}).encode()
req.urlopen(req.Request(
  'https://api.github.com/repos/chuongxl/open-trace/contents/' + path,
  body,
  {'Authorization':'token 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','Content-Type':'application/json'},
  method='PUT'
))
print(path)