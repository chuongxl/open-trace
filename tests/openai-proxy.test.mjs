// #28: OpenAI-compatible clients (Aider, Continue, Cline, Roo Code) through the same proxy port.
// Real proxy, fake OpenAI upstream, assertions on what lands in SQLite and on what upstream receives.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp, proxy, oa, store, pricing, upstream, proxyServer, proxyPort;
const seen = []; // { path, headers, raw }
let respond = null; // optional override per test: (req, raw) => {status, headers, body}

const completion = (extra = {}) => JSON.stringify({
  id: 'chatcmpl-1', object: 'chat.completion', model: 'gpt-4o',
  choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/a.js"}' } }] }, finish_reason: 'tool_calls' }],
  usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 400 } }, ...extra,
});
const sse = (...chunks) => chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
const STREAM = sse(
  { model: 'gpt-4o', choices: [{ index: 0, delta: { role: 'assistant', content: 'Let me look' } }] },
  { model: 'gpt-4o', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_s1', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
  { model: 'gpt-4o', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"b.js"}' } }] } }] },
  { model: 'gpt-4o', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  { model: 'gpt-4o', choices: [], usage: { prompt_tokens: 200, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } } },
);

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ot-oa-'));
  process.env.DB_PATH = join(tmp, 'open-trace.db');
  proxy = await import('../daemon/proxy/claude-proxy.js');
  oa = await import('../daemon/proxy/openai-proxy.js');
  store = await import('../daemon/db/store.js');
  pricing = await import('../daemon/pricing/models.js');
  upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      seen.push({ path: req.url, headers: req.headers, raw });
      const o = respond?.(req, raw);
      if (o) { res.writeHead(o.status, o.headers ?? {}); return res.end(o.body); }
      const stream = raw && JSON.parse(raw).stream;
      // like the real API: compress when the client asks for it
      const gz = /gzip/.test(req.headers['accept-encoding'] ?? '');
      const payload = stream ? STREAM : completion();
      res.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json', ...(gz && { 'content-encoding': 'gzip' }) });
      res.end(gz ? gzipSync(payload) : payload);
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const target = { hostname: '127.0.0.1', port: upstream.address().port, tls: false };
  proxyServer = proxy.createClaudeProxy(0, { upstream: target, openaiUpstream: { ...target, injectUsage: true } });
  await new Promise(r => proxyServer.once('listening', r));
  proxyPort = proxyServer.address().port;
});
after(() => { proxyServer.closeAllConnections?.(); proxyServer.close(); upstream.close(); rmSync(tmp, { recursive: true, force: true }); });

const post = (path, body, headers = {}) => new Promise((resolve, reject) => {
  const raw = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port: proxyPort, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': raw.length, authorization: 'Bearer test-key', ...headers } }, (res) => {
    const out = []; res.on('data', c => out.push(c)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(out).toString() }));
  });
  r.on('error', reject); r.end(raw);
});
const last = () => seen[seen.length - 1];
// by project path, or (no project known) by the client name used as project name
const sessionFor = (project) => store.getSessions({ project })[0] ?? store.getSessions({}).find(s => !s.project_path && s.project_name === project);
const b64 = (s) => Buffer.from(s).toString('base64url');

const chat = (messages, extra = {}) => ({ model: 'gpt-4o', messages, ...extra });
const SYS = { role: 'system', content: 'Act as an expert software developer.' };

test('routing: chat/completions goes to the OpenAI path, Anthropic requests do not', () => {
  const req = (url, headers = {}) => ({ method: 'POST', url, headers });
  assert.equal(oa.isOpenAIRequest(req('/v1/chat/completions')), true);
  assert.equal(oa.isOpenAIRequest(req('/chat/completions?x=1')), true);
  assert.equal(oa.isOpenAIRequest(req('/_cwd/abc/v1/chat/completions')), true);
  assert.equal(oa.isOpenAIRequest(req('/v1/embeddings')), true);
  assert.equal(oa.isOpenAIRequest(req('/v1/messages', { 'anthropic-version': '2023-06-01' })), false);
  assert.equal(oa.isOpenAIRequest(req('/v1/chat/completions', { 'anthropic-version': '2023-06-01' })), false);
  assert.equal(oa.isOpenAIRequest({ method: 'GET', url: '/v1/chat/completions', headers: {} }), false);
});

test('non-streaming: response is untouched, usage/cost/tool call are stored, client is detected', async () => {
  const body = chat([SYS, { role: 'user', content: 'fix the parser' }]);
  const r = await post('/v1/chat/completions', body, { 'user-agent': 'litellm/1.50 aider/0.60', 'accept-encoding': 'gzip, deflate, br' });
  assert.equal(r.status, 200);
  assert.equal(r.text, completion());
  assert.equal(last().raw, JSON.stringify(body), 'request forwarded byte for byte');
  assert.equal(last().path, '/v1/chat/completions');
  assert.equal(last().headers['accept-encoding'], 'identity');

  const s = sessionFor('aider');
  assert.ok(s, 'session created, named after the client when no project is known');
  assert.equal(s.tool, 'aider');
  assert.equal(s.total_input_tokens, 600, 'prompt tokens minus cached');
  assert.equal(s.total_cache_read, 400);
  assert.equal(s.total_output_tokens, 50);
  assert.ok(Math.abs(s.equiv_cost_usd - pricing.estimateCost('gpt-4o', { input_tokens: 600, output_tokens: 50, cache_read_tokens: 400 })) < 1e-12);
  const [p] = store.getPrompts(s.id);
  assert.equal(p.input_text, 'fix the parser');
  const [call] = store.getToolCalls(p.id);
  assert.equal(call.name, 'read_file');
  assert.equal(call.tool_use_id, 'call_1');
  assert.deepEqual(JSON.parse(call.input), { path: 'src/a.js' });
});

test('a tool result in the next request fills the earlier call, and the continuation joins the same turn', async () => {
  const msgs = [SYS, { role: 'user', content: 'fix the parser' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/a.js"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'x'.repeat(3000) }];
  respond = () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: completion({ choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] }) });
  await post('/v1/chat/completions', chat(msgs), { 'user-agent': 'aider/0.60' });
  respond = null;

  const s = sessionFor('aider');
  const turns = store.getPrompts(s.id);
  assert.equal(turns.length, 1, 'same conversation, same session; continuation grouped under the prompt');
  assert.equal(turns[0].request_count, 2);
  const [call] = store.getToolCalls(turns[0].id);
  assert.equal(call.output.length, 3000);
  assert.ok(call.duration_ms >= 0);
  const ctx = store.getContextRows(s.id).map(r => JSON.parse(r.context));
  assert.ok(ctx[1].sections.tool_results >= 3000, 'context inspector data built from OpenAI-shaped messages');
  assert.ok(ctx[1].sections.system > 0);
});

test('streaming: tool-call fragments are joined and the final usage chunk is read; usage is requested upstream', async () => {
  const body = chat([SYS, { role: 'user', content: 'stream please' }], { stream: true });
  const r = await post('/v1/chat/completions', body, { 'user-agent': 'aider/0.60' });
  assert.equal(r.text, STREAM, 'client receives the stream unchanged');
  const sent = JSON.parse(last().raw);
  assert.deepEqual(sent.stream_options, { include_usage: true }, 'usage requested from the upstream');
  assert.equal(Number(last().headers['content-length']), Buffer.byteLength(last().raw), 'content-length matches the changed body');

  const s = sessionFor('aider');
  const turn = store.getPrompts(s.id).find(t => t.input_text === 'stream please');
  assert.equal(turn.input_tokens, 200);
  assert.equal(turn.output_tokens, 20);
  assert.ok(turn.first_token_ms >= 0 && turn.request_ms >= 0);
  const [call] = store.getToolCalls(turn.id);
  assert.equal(call.tool_use_id, 'call_s1');
  assert.deepEqual(JSON.parse(call.input), { path: 'b.js' });
});

test('stream_options already set by the client are kept, and injection can be off', async () => {
  oa.setOpenAIUpstream({ hostname: '127.0.0.1', port: upstream.address().port, tls: false, injectUsage: false });
  const body = chat([SYS, { role: 'user', content: 'no injection' }], { stream: true });
  await post('/v1/chat/completions', body);
  assert.equal(last().raw, JSON.stringify(body), 'untouched when injection is off');
  oa.setOpenAIUpstream({ hostname: '127.0.0.1', port: upstream.address().port, tls: false, injectUsage: true });
  const own = chat([SYS, { role: 'user', content: 'own usage' }], { stream: true, stream_options: { include_usage: true, other: 1 } });
  await post('/v1/chat/completions', own);
  assert.deepEqual(JSON.parse(last().raw).stream_options, { include_usage: true, other: 1 });
});

test('project from the /_cwd prefix: stripped before forwarding, session grouped by project', async () => {
  const cwd = '/work/prefixed';
  await post(`/_cwd/${b64(cwd)}/v1/chat/completions`, chat([SYS, { role: 'user', content: 'hi' }]), { 'user-agent': 'aider/1' });
  assert.equal(last().path, '/v1/chat/completions');
  const s = sessionFor(cwd);
  assert.equal(s.project_name, 'prefixed');
  await post(`/_cwd/${b64(cwd)}/v1/chat/completions`, chat([SYS, { role: 'user', content: 'a different conversation' }]), { 'user-agent': 'aider/1' });
  assert.equal(store.getSessions({ project: cwd }).length, 1, 'same project, one session');
});

test('project from Cline/Roo style environment details, and the client from the system prompt', async () => {
  const body = chat([
    { role: 'system', content: 'You are Cline, a highly skilled software engineer.' },
    { role: 'user', content: [{ type: 'text', text: 'rename foo' }, { type: 'text', text: '<environment_details>\n# Current Working Directory (/work/cline-proj) Files\nsrc/\n</environment_details>' }] },
  ]);
  await post('/v1/chat/completions', body);
  const s = sessionFor('/work/cline-proj');
  assert.equal(s.tool, 'cline');
  assert.equal(s.project_name, 'cline-proj');
  assert.equal(store.getPrompts(s.id)[0].input_text, 'rename foo\n<environment_details>\n# Current Working Directory (/work/cline-proj) Files\nsrc/\n</environment_details>'.slice(0, 2000));
});

test('without any project hint, different conversations get different sessions', async () => {
  const a = chat([{ role: 'system', content: 'sys A' }, { role: 'user', content: 'conversation one' }]);
  const b = chat([{ role: 'system', content: 'sys A' }, { role: 'user', content: 'conversation two' }]);
  await post('/v1/chat/completions', a); await post('/v1/chat/completions', a);
  await post('/v1/chat/completions', b);
  const sessions = store.getSessions({}).filter(s => s.tool === 'openai-compat');
  assert.equal(sessions.length, 2);
});

test('errors and non-chat endpoints are passed through and not stored', async () => {
  const before = store.getSessions({}).length;
  respond = () => ({ status: 429, headers: { 'content-type': 'application/json' }, body: '{"error":{"message":"rate limited"}}' });
  const r = await post('/v1/chat/completions', chat([{ role: 'user', content: 'will fail' }]));
  assert.equal(r.status, 429);
  assert.match(r.text, /rate limited/);
  respond = () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"data":[]}' });
  const e = await post('/v1/embeddings', { model: 'text-embedding-3-small', input: 'x' });
  assert.equal(e.text, '{"data":[]}');
  assert.equal(last().path, '/v1/embeddings');
  respond = null;
  assert.equal(store.getSessions({}).length, before, 'nothing stored for either');
});

test('Claude Code traffic on the same port still takes the Anthropic path', async () => {
  const r = await new Promise((resolve, reject) => {
    const raw = Buffer.from(JSON.stringify({ model: 'claude-sonnet-4-5', stream: false, system: 'cwd: /work/claude\n', messages: [{ role: 'user', content: 'hi' }] }));
    const q = http.request({ host: '127.0.0.1', port: proxyPort, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'content-length': raw.length } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    q.on('error', reject); q.end(raw);
  });
  assert.equal(r, 200);
  assert.equal(last().path, '/v1/messages');
});
