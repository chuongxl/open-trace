// Phase 12c (#55): request pipeline. No hook = byte-identical pass-through; a hook may hold
// or replace the body (content-length recomputed). Runs the real proxy against a fake upstream.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp, proxy, upstream, proxyServer, proxyPort;
const seen = []; // what the fake upstream received

const REPLY = JSON.stringify({ type: 'message', model: 'claude-sonnet-4-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'hi' }] });
const SSE = ['message_start', 'message_stop']
  .map(t => `event: ${t}\ndata: ${JSON.stringify(t === 'message_start' ? { type: t, message: { model: 'm', usage: { input_tokens: 1 } } } : { type: t })}\n\n`).join('');

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ot-pipe-'));
  process.env.DB_PATH = join(tmp, 'open-trace.db');
  proxy = await import('../daemon/proxy/claude-proxy.js');
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ body, headers: req.headers });
      const stream = JSON.parse(body.toString()).stream;
      res.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json' });
      res.end(stream ? SSE : REPLY);
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  proxyServer = proxy.createClaudeProxy(0, { upstream: { hostname: '127.0.0.1', port: upstream.address().port, tls: false } });
  await new Promise(r => proxyServer.once('listening', r));
  proxyPort = proxyServer.address().port;
});

after(() => {
  proxy.setRequestHook(null);
  proxyServer.close(); upstream.close();
  rmSync(tmp, { recursive: true, force: true });
});

const send = (raw) => new Promise((resolve, reject) => {
  const body = Buffer.from(raw);
  const req = http.request({ host: '127.0.0.1', port: proxyPort, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': body.length } }, (res) => {
    const out = []; res.on('data', c => out.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(out).toString() }));
  });
  req.on('error', reject); req.end(body);
});

const ODD = '{ "model":"claude-sonnet-4-5",  "stream": false,\n "system":"cwd: /tmp/pipe\\n", "messages":[{"role":"user","content":"héllo → ✓"}] }';

test('no hook: upstream receives the exact bytes and original content-length', async () => {
  proxy.setRequestHook(null);
  const before = seen.length;
  const r = await send(ODD);
  assert.equal(r.status, 200);
  assert.equal(r.body, REPLY);
  const got = seen[before];
  assert.ok(got.body.equals(Buffer.from(ODD)), 'body is byte-identical');
  assert.equal(Number(got.headers['content-length']), Buffer.byteLength(ODD));
});

test('a hook can replace the body; content-length matches the new body', async () => {
  const ids = [];
  proxy.setRequestHook(async ({ requestId, body }) => {
    ids.push(requestId);
    return { body: { ...body, messages: [...body.messages, { role: 'user', content: 'injected — ünïcode' }] } };
  });
  const before = seen.length;
  await send(ODD);
  await send(ODD);
  const got = seen[before];
  const parsed = JSON.parse(got.body.toString());
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[1].content, 'injected — ünïcode');
  assert.equal(Number(got.headers['content-length']), got.body.length, 'content-length equals bytes sent');
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1], 'unique requestId per request');
  assert.match(ids[0], /^[0-9a-f-]{36}$/);
});

test('a held request is not forwarded until the hook resolves', async () => {
  let release;
  proxy.setRequestHook(() => new Promise(r => { release = r; }));
  const before = seen.length;
  const pending = send(ODD);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(seen.length, before, 'nothing reached upstream while held');
  release();
  assert.equal((await pending).status, 200);
  assert.equal(seen.length, before + 1);
});

test('a throwing hook fails open: the original request is forwarded', async () => {
  proxy.setRequestHook(() => { throw new Error('boom'); });
  const before = seen.length;
  const r = await send(ODD);
  assert.equal(r.status, 200);
  assert.ok(seen[before].body.equals(Buffer.from(ODD)));
});

test('streaming requests go through the same pipeline', async () => {
  proxy.setRequestHook(async ({ body }) => ({ body: { ...body, max_tokens: 7 } }));
  const before = seen.length;
  const r = await send(ODD.replace('"stream": false', '"stream": true'));
  assert.equal(r.status, 200);
  assert.ok(r.body.includes('message_stop'));
  const got = seen[before];
  assert.equal(JSON.parse(got.body.toString()).max_tokens, 7);
  assert.equal(Number(got.headers['content-length']), got.body.length);
});

test('a client that disconnects while held is never forwarded', async () => {
  let release, aborted;
  proxy.setRequestHook(({ signal }) => new Promise(r => { release = r; signal.addEventListener('abort', () => { aborted = true; }); }));
  const before = seen.length;
  const req = http.request({ host: '127.0.0.1', port: proxyPort, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(ODD) } });
  req.on('error', () => {});
  req.end(ODD);
  await new Promise(r => setTimeout(r, 200));
  req.destroy();
  await new Promise(r => setTimeout(r, 200));
  assert.equal(aborted, true, 'hook sees the abort');
  release();
  await new Promise(r => setTimeout(r, 200));
  assert.equal(seen.length, before, 'held request dropped, not forwarded');
});
