// Phase 14 (#58): the pause / step / continue / stop demo, end to end with real HTTP clients:
// Claude-Code-shaped requests -> real proxy -> fake upstream, controlled through the real API router.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp, proxy, dbg, events, upstream, proxyServer, proxyPort, apiServer, apiPort, sid, off;
const upstreamSeen = [];
const states = [];

const REPLY = JSON.stringify({ type: 'message', model: 'claude-sonnet-4-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'ok' }] });
const SSE = ['message_start', 'message_stop'].map(t => `event: ${t}\ndata: ${JSON.stringify(t === 'message_start' ? { type: t, message: { model: 'm', usage: { input_tokens: 1 } } } : { type: t })}\n\n`).join('');

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ot-dbg-'));
  process.env.DB_PATH = join(tmp, 'open-trace.db');
  proxy = await import('../daemon/proxy/claude-proxy.js');
  dbg = await import('../daemon/debugger.js');
  events = await import('../daemon/events.js');
  const { default: router } = await import('../daemon/api/router.js');

  upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      upstreamSeen.push(body);
      res.writeHead(200, { 'content-type': body.stream ? 'text/event-stream' : 'application/json' });
      res.end(body.stream ? SSE : REPLY);
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  proxyServer = proxy.createClaudeProxy(0, { upstream: { hostname: '127.0.0.1', port: upstream.address().port, tls: false } });
  await new Promise(r => proxyServer.once('listening', r));
  proxyPort = proxyServer.address().port;
  proxy.setRequestHook(dbg.debugHook);

  const app = express(); app.use(express.json()); app.use('/api', router);
  apiServer = http.createServer(app);
  await new Promise(r => apiServer.listen(0, '127.0.0.1', r));
  apiPort = apiServer.address().port;
  off = events.subscribe(e => e.type === 'debug_state' && states.push(e.data));

  await send(req('first')); // creates the session
  sid = (await import('../daemon/db/store.js')).getSessions({ project: '/tmp/dbg-proj' })[0].id;
});
after(() => {
  off?.(); proxy.setRequestHook(null);
  proxyServer.closeAllConnections?.(); proxyServer.close(); upstream.close(); apiServer.close();
  rmSync(tmp, { recursive: true, force: true });
});

const TOOLS = [{ name: 'Bash' }];
const req = (text, extra = {}) => ({ model: 'claude-sonnet-4-5', stream: false, tools: TOOLS, system: 'cwd: /tmp/dbg-proj\n', messages: [{ role: 'user', content: text }], ...extra });
const continuation = (extra = {}) => req('go', { messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'done' }] }], ...extra });

const send = (body) => new Promise((resolve, reject) => {
  const raw = Buffer.from(JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port: proxyPort, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': raw.length } }, (res) => {
    const out = []; res.on('data', c => out.push(c)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(out).toString() }));
  });
  r.on('error', reject); r.end(raw);
});
const api = async (path, method = 'GET', body) => {
  const res = await fetch(`http://127.0.0.1:${apiPort}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const tick = (ms = 150) => new Promise(r => setTimeout(r, ms));
const state = async () => (await api(`/sessions/${sid}/debug`)).body;

test('pause holds the next request; step releases exactly one and re-holds; continue releases and runs free', async () => {
  assert.equal((await state()).state, 'running');
  assert.equal((await api(`/sessions/${sid}/pause`, 'POST')).body.state, 'pausing');

  const before = upstreamSeen.length;
  const b = send(req('B')); await tick();
  assert.equal(upstreamSeen.length, before, 'B is held, upstream has not seen it');
  const held = await state();
  assert.equal(held.state, 'paused');
  assert.equal(held.held.length, 1);

  const stepped = await api(`/sessions/${sid}/step`, 'POST');
  assert.equal(stepped.body.state, 'pausing', 'stepping re-arms the hold');
  assert.equal((await b).status, 200);
  assert.equal(upstreamSeen.length, before + 1);

  const c = send(req('C')); await tick();
  assert.equal((await state()).state, 'paused', 'next request is held again');
  assert.equal((await api(`/sessions/${sid}/continue`, 'POST')).body.state, 'running');
  assert.equal((await c).status, 200);

  assert.equal((await send(req('D'))).status, 200, 'no longer holding');
});

test('step with nothing held is a 409; unknown sessions are 404', async () => {
  assert.equal((await api(`/sessions/${sid}/step`, 'POST')).status, 409);
  assert.equal((await api('/sessions/nope/pause', 'POST')).status, 404);
  assert.equal((await api('/sessions/nope/debug')).status, 404);
});

test('requests without tools (background calls) are never held', async () => {
  await api(`/sessions/${sid}/pause`, 'POST');
  assert.equal((await send(req('title please', { tools: undefined }))).status, 200);
  await api(`/sessions/${sid}/continue`, 'POST');
});

test('stop answers a held request with a clean synthetic end_turn, non-streaming and streaming', async () => {
  for (const stream of [false, true]) {
    await api(`/sessions/${sid}/pause`, 'POST');
    const before = upstreamSeen.length;
    const held = send(req('E', { stream })); await tick();
    assert.equal((await state()).state, 'paused');
    assert.equal((await api(`/sessions/${sid}/stop`, 'POST')).body.state, 'running');
    const r = await held;
    assert.equal(r.status, 200);
    assert.equal(upstreamSeen.length, before, 'stopped request never reaches upstream');
    if (!stream) {
      const m = JSON.parse(r.text);
      assert.equal(m.role, 'assistant'); assert.equal(m.stop_reason, 'end_turn'); assert.equal(m.content[0].text, dbg.STOP_TEXT);
    } else {
      const evs = [...r.text.matchAll(/^event: (\w+)$/gm)].map(x => x[1]);
      assert.deepEqual(evs, ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
      assert.ok(r.text.includes('"stop_reason":"end_turn"') && r.text.includes(dbg.STOP_TEXT));
    }
  }
});

test('stop with nothing held is armed for the next tool-loop continuation only, not a new prompt', async () => {
  assert.equal((await api(`/sessions/${sid}/stop`, 'POST')).body.state, 'stopping');
  const before = upstreamSeen.length;
  assert.equal((await send(req('a brand new prompt'))).text, REPLY, 'a fresh prompt passes through');
  assert.equal(upstreamSeen.length, before + 1);
  const r = JSON.parse((await send(continuation())).text);
  assert.equal(r.content[0].text, dbg.STOP_TEXT, 'the continuation is stopped');
  assert.equal(upstreamSeen.length, before + 1);
  assert.equal((await state()).state, 'running');
  assert.equal((await send(continuation())).text, REPLY, 'back to normal afterwards');
});

test('a client that disconnects while held is dropped from the held list', async () => {
  await api(`/sessions/${sid}/pause`, 'POST');
  const raw = Buffer.from(JSON.stringify(req('F')));
  const r = http.request({ host: '127.0.0.1', port: proxyPort, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': raw.length } });
  r.on('error', () => {}); r.end(raw);
  await tick();
  assert.equal((await state()).held.length, 1);
  r.destroy(); await tick();
  assert.equal((await state()).held.length, 0);
  await api(`/sessions/${sid}/continue`, 'POST');
});

test('break on alert pauses an opted-in session at its next request; others are untouched', async () => {
  const stop = dbg.startDebugger();
  events.emit('alert', { session_id: sid, kind: 'repeat_call' });
  assert.equal((await state()).state, 'running', 'not opted in');
  assert.equal((await api(`/sessions/${sid}/break-on-alert`, 'POST', { enabled: true })).body.break_on_alert, true);
  events.emit('alert', { session_id: sid, kind: 'repeat_call' });
  assert.equal((await state()).state, 'pausing');
  assert.equal(states.at(-1).reason, 'alert');
  const held = send(req('G')); await tick();
  assert.equal((await state()).state, 'paused');
  await api(`/sessions/${sid}/continue`, 'POST'); await held;
  await api(`/sessions/${sid}/break-on-alert`, 'POST', { enabled: false });
  stop();
});
