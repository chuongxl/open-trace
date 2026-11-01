// #64 end to end: a secret in a request, a tool result and a response is stored redacted while the
// forwarded request is untouched; rows older than the retention window are deleted.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp, proxy, store, retention, upstream, proxyServer, proxyPort;
const seen = [];
const KEY = 'sk-ant-' + 'api03-' + 'S'.repeat(40);   // built at runtime: no secret-shaped literal in the repo
const GH = 'ghp_' + 'T'.repeat(36);

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ot-priv-'));
  process.env.DB_PATH = join(tmp, 'open-trace.db');
  proxy = await import('../daemon/proxy/claude-proxy.js');
  store = await import('../daemon/db/store.js');
  retention = await import('../daemon/retention.js');
  upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      seen.push(Buffer.concat(chunks).toString());
      res.writeHead(200, { 'content-type': 'application/json' });
      // the model echoes a token back, so the response holds one too
      res.end(JSON.stringify({ type: 'message', model: 'claude-sonnet-4-5', usage: { input_tokens: 5, output_tokens: 5 }, content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: `curl -H "Authorization: Bearer ${GH}"` } }] }));
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  proxyServer = proxy.createClaudeProxy(0, { upstream: { hostname: '127.0.0.1', port: upstream.address().port, tls: false } });
  await new Promise(r => proxyServer.once('listening', r));
  proxyPort = proxyServer.address().port;
});
after(() => { proxyServer.closeAllConnections?.(); proxyServer.close(); upstream.close(); rmSync(tmp, { recursive: true, force: true }); });

const send = (body) => new Promise((resolve, reject) => {
  const raw = Buffer.from(JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port: proxyPort, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': raw.length } }, (res) => {
    const out = []; res.on('data', c => out.push(c)); res.on('end', () => resolve(Buffer.concat(out).toString()));
  });
  r.on('error', reject); r.end(raw);
});
const dump = () => JSON.stringify([
  store.getDb().prepare('SELECT * FROM prompts').all(),
  store.getDb().prepare('SELECT * FROM tool_calls').all(),
]);

test('secrets in the request, tool result and response are stored redacted; the forwarded request is not changed', async () => {
  const base = { model: 'claude-sonnet-4-5', stream: false, tools: [{ name: 'Bash' }], system: 'cwd: /tmp/priv\n' };
  await send({ ...base, messages: [{ role: 'user', content: `deploy with ANTHROPIC_API_KEY=${KEY}` }] });
  await send({ ...base, messages: [
    { role: 'user', content: `deploy with ANTHROPIC_API_KEY=${KEY}` },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'cat .env' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: `ANTHROPIC_API_KEY=${KEY}\nTOKEN=${GH}` }] },
  ] });

  assert.ok(seen.every(b => b.includes(KEY)), 'upstream still receives the real request');
  const stored = dump();
  assert.ok(!stored.includes(KEY) && !stored.includes('S'.repeat(40)), 'API key leaked into the database');
  assert.ok(!stored.includes(GH), 'GitHub token leaked into the database');
  assert.ok(stored.includes('[REDACTED:'), 'markers present');
  const [session] = store.getSessions({ project: '/tmp/priv' });
  assert.match(store.getPrompts(session.id)[0].input_text, /deploy with ANTHROPIC_API_KEY=\[REDACTED/);
});

test('a secret that straddles the raw-request cap is removed before the text is cut', async () => {
  const filler = 'x'.repeat(31_980);
  await send({ model: 'claude-sonnet-4-5', stream: false, system: 'cwd: /tmp/priv-cap\n', messages: [{ role: 'user', content: filler + ' ' + KEY }] });
  const [row] = store.getDb().prepare("SELECT raw_request FROM prompts WHERE session_id = (SELECT id FROM sessions WHERE project_path = '/tmp/priv-cap')").all();
  assert.ok(!row.raw_request.includes('sk-ant-'), 'a partial key survived the cut');
});

test('redactStoredRows cleans rows written before redaction existed', () => {
  const db = store.getDb();
  store.upsertSession({ id: 'legacy', tool: 'opencode', started_at: Date.now(), project_path: null, project_name: 'l', model: 'm', equiv_cost_usd: 0 });
  db.prepare("INSERT INTO prompts (id, session_id, timestamp, input_text) VALUES ('legacy-p', 'legacy', ?, ?)").run(Date.now(), `my key is ${KEY}`);
  db.prepare("INSERT INTO tool_calls (id, prompt_id, call_order, call_type, name, output, timestamp) VALUES ('legacy-t', 'legacy-p', 0, 'tool', 'Bash', ?, ?)").run(`token ${GH}`, Date.now());
  assert.ok(store.redactStoredRows() >= 2);
  assert.ok(!dump().includes(KEY) && !dump().includes(GH));
  assert.equal(store.redactStoredRows(), 0, 'second run has nothing to do');
});

test('retention deletes rows past the window and keeps recent ones, including a long-lived session', () => {
  const DAY = 86_400_000, now = Date.now();
  const db = store.getDb();
  const session = (id, started) => store.upsertSession({ id, tool: 'claude-code', started_at: started, project_path: null, project_name: id, model: 'm', equiv_cost_usd: 0 });
  const prompt = (id, sid, ts) => store.insertPrompt({ id, session_id: sid, timestamp: ts, input_text: id });
  const call = (id, pid) => store.insertToolCall({ id, prompt_id: pid, call_order: 0, call_type: 'tool', name: 'Read', timestamp: now });

  session('old-s', now - 40 * DAY);  prompt('old-p', 'old-s', now - 40 * DAY); call('old-c', 'old-p');
  store.insertOptimization({ id: 'old-o', prompt_id: 'old-p', original_prompt: 'a', optimized_prompt: 'b', improvement_notes: 'n', created_at: now });
  store.insertAlert({ session_id: 'old-s', kind: 'cost_high', dedupe_key: 'k', message: 'm' });
  store.addOverlayRule('old-s', 'append_user_message', { text: 'x' });
  store.addOverlayAudit({ session_id: 'old-s', action: 'applied' });
  session('new-s', now - DAY);       prompt('new-p', 'new-s', now - DAY);       call('new-c', 'new-p');
  session('long-s', now - 40 * DAY); prompt('long-old', 'long-s', now - 40 * DAY); prompt('long-new', 'long-s', now - 2 * DAY);

  assert.equal(retention.pruneExpired(0), null, 'retention off: nothing happens');
  const r = retention.pruneExpired(30);
  assert.equal(r.sessions, 1);
  const ids = (sql) => db.prepare(sql).all().map(x => x.id);
  assert.deepEqual(ids("SELECT id FROM prompts WHERE id IN ('old-p','new-p','long-old','long-new') ORDER BY id"), ['long-new', 'new-p']);
  assert.deepEqual(ids("SELECT id FROM tool_calls WHERE id LIKE '%-c'"), ['new-c']);
  assert.equal(db.prepare("SELECT count(*) n FROM optimizations WHERE id = 'old-o'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM alerts WHERE session_id = 'old-s'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM overlay_rules WHERE session_id = 'old-s'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM overlay_audit WHERE session_id = 'old-s'").get().n, 0);
  assert.deepEqual(ids("SELECT id FROM sessions WHERE id IN ('old-s','new-s','long-s') ORDER BY id"), ['long-s', 'new-s']);
  assert.equal(retention.retentionCutoff(0), null);
});
