// Phase 15 (#59) end to end: rules created through the API change what upstream receives, on every turn,
// while the audit trail records it. Real proxy + fake upstream + real router.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp, proxy, hooks, dbg, overlay, store, upstream, proxyServer, proxyPort, apiServer, apiPort, sid;
const seen = [];
const REPLY = JSON.stringify({ type: 'message', model: 'claude-sonnet-4-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'ok' }] });

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ot-ovl-'));
  process.env.DB_PATH = join(tmp, 'open-trace.db');
  proxy = await import('../daemon/proxy/claude-proxy.js');
  hooks = await import('../daemon/hooks.js');
  dbg = await import('../daemon/debugger.js');
  overlay = await import('../daemon/overlay.js');
  store = await import('../daemon/db/store.js');
  const { default: router } = await import('../daemon/api/router.js');

  upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => { seen.push(JSON.parse(Buffer.concat(chunks).toString())); res.writeHead(200, { 'content-type': 'application/json' }); res.end(REPLY); });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  proxyServer = proxy.createClaudeProxy(0, { upstream: { hostname: '127.0.0.1', port: upstream.address().port, tls: false } });
  await new Promise(r => proxyServer.once('listening', r));
  proxyPort = proxyServer.address().port;
  proxy.setRequestHook(hooks.pipelineHook);

  const app = express(); app.use(express.json()); app.use('/api', router);
  apiServer = http.createServer(app);
  await new Promise(r => apiServer.listen(0, '127.0.0.1', r));
  apiPort = apiServer.address().port;

  await send(history(1)); // creates the session
  sid = store.getSessions({ project: '/tmp/ovl-proj' })[0].id;
});
after(() => {
  overlay.setPassthrough(false); proxy.setRequestHook(null);
  proxyServer.closeAllConnections?.(); proxyServer.close(); upstream.close(); apiServer.close();
  rmSync(tmp, { recursive: true, force: true });
});

// A growing Claude-Code-shaped history: user, then n tool loops of (assistant tool_use, user tool_result).
const history = (loops, resultText = 'R'.repeat(2000)) => {
  const messages = [{ role: 'user', content: 'fix the bug' }];
  for (let i = 1; i <= loops - 1; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: {} }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: resultText }] });
  }
  return { model: 'claude-sonnet-4-5', stream: false, tools: [{ name: 'Read' }], system: 'cwd: /tmp/ovl-proj\n', messages };
};
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
const last = () => seen[seen.length - 1];
const texts = (m) => (typeof m.content === 'string' ? [m.content] : m.content.filter(b => b.type === 'text').map(b => b.text));
const audit = async () => (await api(`/sessions/${sid}/overlay`)).body.audit;

test('with no rules the body reaches upstream untouched', async () => {
  await send(history(3));
  assert.deepEqual(last().messages, history(3).messages);
});

test('an injected message is applied now and re-applied at the same point as the history grows', async () => {
  const created = await api(`/sessions/${sid}/overlay/rules`, 'POST', { kind: 'append_user_message', params: { text: 'Do not touch the database.' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.preview, null, 'nothing held, so no preview');

  await send(history(3)); // 5 messages, ends with a tool_result
  let m = last().messages;
  assert.equal(m.length, 5);
  assert.deepEqual(texts(m[4]), ['Do not touch the database.'], 'merged into the last user message');
  assert.equal(m[4].content[0].type, 'tool_result');

  await send(history(5)); // the client knows nothing about the injection
  m = last().messages;
  assert.equal(m.length, 9);
  assert.deepEqual(texts(m[4]), ['Do not touch the database.'], 'still after the 5th message, not at the end');
  assert.deepEqual(texts(m[8]), [], 'nothing duplicated at the end');
  assert.equal(store.getOverlayRules(sid)[0].anchor, 5, 'anchor persisted');
});

test('the audit trail records the rule and every application', async () => {
  const a = await audit();
  assert.ok(a.some(x => x.action === 'rule_added'));
  assert.equal(a.filter(x => x.action === 'applied').length, 2);
  assert.match(a.find(x => x.action === 'applied').detail, /injected 26 characters/);
});

test('preview against a held request reports validity and a one-time equiv. cache cost; creation rejects invalid edits', async () => {
  assert.equal((await api(`/sessions/${sid}/overlay/preview`, 'POST', { kind: 'delete_message', params: { indices: [1] } })).status, 409, 'needs a held request');
  await api(`/sessions/${sid}/pause`, 'POST');
  const held = send(history(4)); await tick();

  const good = (await api(`/sessions/${sid}/overlay/preview`, 'POST', { kind: 'truncate_tool_result', params: { max_chars: 100 } })).body;
  assert.equal(good.valid, true);
  assert.ok(good.cache.tokens > 0 && good.cache.extra_equiv_cost_usd > 0);
  assert.equal(good.cache.from_index, 2);

  const bad = await api(`/sessions/${sid}/overlay/rules`, 'POST', { kind: 'delete_message', params: { indices: [1] } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /tool call/);
  assert.equal(store.getOverlayRules(sid).length, 1, 'invalid rule not stored');

  const added = await api(`/sessions/${sid}/overlay/rules`, 'POST', { kind: 'truncate_tool_result', params: { max_chars: 100 } });
  assert.equal(added.status, 201);
  await api(`/sessions/${sid}/continue`, 'POST'); await held;
  const result = last().messages[2].content[0].content;
  assert.match(result, /truncated by open-trace/);
  assert.ok(result.length < 300);
});

test('an edit that becomes invalid later is never forwarded; the original goes through and the audit says why', async () => {
  const r = await api(`/sessions/${sid}/overlay/rules`, 'POST', { kind: 'delete_message', params: { indices: [1] } });
  assert.equal(r.status, 201, 'no held request: accepted, validated when applied');
  const body = history(4);
  await send(body);
  assert.equal(last().messages.length, 7, 'original history, no deletion, no injection');
  assert.ok(!JSON.stringify(last().messages).includes('Do not touch'), 'whole overlay skipped, not half applied');
  assert.ok((await audit()).some(x => x.action === 'rejected' && /tool call/.test(x.detail)));
  const bad = store.getOverlayRules(sid).find(x => x.kind === 'delete_message');
  assert.equal((await api(`/sessions/${sid}/overlay/rules/${bad.id}`, 'DELETE')).status, 200);
  assert.equal((await api(`/sessions/${sid}/overlay/rules/${bad.id}`, 'DELETE')).status, 404);
});

test('global pass-through disables every rule and is audited', async () => {
  assert.equal((await api('/overlay/passthrough', 'POST', { enabled: true })).body.passthrough, true);
  const body = history(3);
  await send(body);
  assert.deepEqual(last().messages, body.messages);
  assert.equal((await api('/overlay/passthrough', 'POST', { enabled: false })).body.passthrough, false);
  await send(history(3));
  assert.notDeepEqual(last().messages, body.messages, 'rules apply again');
});

test('removing a rule stops its effect; unknown sessions and bad rules are rejected', async () => {
  for (const r of store.getOverlayRules(sid)) await api(`/sessions/${sid}/overlay/rules/${r.id}`, 'DELETE');
  const body = history(3);
  await send(body);
  assert.deepEqual(last().messages, body.messages);
  assert.equal((await api('/sessions/nope/overlay')).status, 404);
  assert.equal((await api(`/sessions/${sid}/overlay/rules`, 'POST', { kind: 'append_user_message', params: { text: ' ' } })).status, 400);
  assert.equal((await api(`/sessions/${sid}/overlay/rules`, 'POST', { kind: 'explode', params: {} })).status, 400);
});

test('a stop still wins over the overlay', async () => {
  await api(`/sessions/${sid}/overlay/rules`, 'POST', { kind: 'append_user_message', params: { text: 'x' } });
  const out = await hooks.pipelineHook({ sessionId: sid, requestId: 'r', body: { ...history(3), messages: history(3).messages }, signal: new AbortController().signal });
  assert.equal(out.body.messages.length, 5);
  await api(`/sessions/${sid}/stop`, 'POST');
  const stopped = await hooks.pipelineHook({ sessionId: sid, requestId: 'r2', body: history(3), signal: new AbortController().signal });
  assert.equal(stopped.respond.text, dbg.STOP_TEXT);
});
