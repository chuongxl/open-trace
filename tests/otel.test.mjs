// #25: OTLP/HTTP JSON receiver. Mapper and ingest in process; the route (guard, status codes) against a real daemon.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
let tmp, store, otel, mapper, events, pricing, child, base, token, out = '';

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ot-otel-'));
  process.env.DB_PATH = join(tmp, 'in-process.db');
  store = await import('../daemon/db/store.js');
  otel = await import('../daemon/otel/ingest.js');
  mapper = await import('../daemon/otel/mapper.js');
  events = await import('../daemon/events.js');
  pricing = await import('../daemon/pricing/models.js');

  child = spawn(process.execPath, [join(REPO, 'daemon', 'index.js')], {
    cwd: REPO,
    env: { ...process.env, DB_PATH: join(tmp, 'daemon.db'), OPENCODE_DB_PATH: join(tmp, 'none.db'), DAEMON_PORT: '0', CLAUDE_PROXY_PORT: '0', COPILOT_PROXY_PORT: '0' },
  });
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  const deadline = Date.now() + 20000; let port;
  while (Date.now() < deadline && !port) { port = out.match(/Dashboard at http:\/\/localhost:(\d+)/)?.[1]; await new Promise(r => setTimeout(r, 200)); }
  assert.ok(port, 'daemon did not start: ' + out.slice(-500));
  base = `http://127.0.0.1:${port}`;
  token = readFileSync(join(tmp, 'token'), 'utf8').trim();
});
after(() => { child?.kill('SIGTERM'); rmSync(tmp, { recursive: true, force: true }); });

// ── OTLP/JSON fixtures: 64-bit ints and nanosecond timestamps are strings, as in the spec ──
const S = (key, v) => ({ key, value: { stringValue: v } });
const I = (key, v) => ({ key, value: { intValue: String(v) } });
const D = (key, v) => ({ key, value: { doubleValue: v } });
const T0 = 1_760_000_000_000; // ms
const ns = (ms) => String(BigInt(ms) * 1_000_000n);
let n = 0;
const span = (o) => ({ traceId: o.traceId ?? 'a'.repeat(32), spanId: o.spanId ?? String(++n).padStart(16, '0'), parentSpanId: o.parent, name: o.name ?? 'span',
  startTimeUnixNano: ns(o.start ?? T0), endTimeUnixNano: ns(o.end ?? T0 + 1000), attributes: o.attrs ?? [], events: o.events, status: o.error ? { code: 2 } : undefined });
const payload = (spans, service = 'my-agent', extraRes = []) => ({ resourceSpans: [{ resource: { attributes: [S('service.name', service), ...extraRes] }, scopeSpans: [{ scope: { name: 't' }, spans }] }] });
const chat = (o = {}) => span({ ...o, name: 'chat', attrs: [S('gen_ai.operation.name', 'chat'), S('gen_ai.request.model', o.model ?? 'claude-sonnet-4-5'), I('gen_ai.usage.input_tokens', o.input ?? 1000), I('gen_ai.usage.output_tokens', o.output ?? 50), ...(o.attrs ?? [])] });
const tool = (o = {}) => span({ ...o, name: 'execute_tool', attrs: [S('gen_ai.operation.name', 'execute_tool'), S('gen_ai.tool.name', o.tool ?? 'read_file'), S('gen_ai.tool.call.id', o.callId ?? 'call_1'), S('gen_ai.tool.call.arguments', o.args ?? '{"path":"a.js"}'), S('gen_ai.tool.call.result', o.result ?? 'contents'), ...(o.attrs ?? [])] });
const session = (id) => store.getSessions({}).find(s => s.id === id);

test('a chat span lands as a prompt with tokens, cost, timing and project from service.name', () => {
  const r = otel.ingestTraces(payload([chat({ spanId: 'c1'.padStart(16, '0'), start: T0, end: T0 + 2500, attrs: [S('gen_ai.conversation.id', 'conv-1')] })]));
  assert.deepEqual([r.prompts, r.toolCalls], [1, 0]);
  const s = session('otel-conv-1');
  assert.equal(s.tool, 'otel');
  assert.equal(s.project_name, 'my-agent');
  assert.equal(s.project_path, 'otel:my-agent');
  assert.equal(s.total_input_tokens, 1000);
  assert.equal(s.total_output_tokens, 50);
  assert.ok(Math.abs(s.equiv_cost_usd - pricing.estimateCost('claude-sonnet-4-5', { input_tokens: 1000, output_tokens: 50 })) < 1e-12);
  const [p] = store.getPrompts('otel-conv-1');
  assert.equal(p.timestamp, T0);
  assert.equal(p.request_ms, 2500);
  assert.equal(p.model, 'claude-sonnet-4-5');
});

test('re-sending the same spans (an exporter retry) does not double count', () => {
  const body = payload([chat({ spanId: 'dd'.padStart(16, '0'), attrs: [S('gen_ai.conversation.id', 'conv-retry')] })]);
  otel.ingestTraces(body);
  const again = otel.ingestTraces(body);
  assert.equal(again.prompts, 0);
  assert.equal(session('otel-conv-retry').total_input_tokens, 1000);
  assert.equal(store.getPrompts('otel-conv-retry').length, 1);
});

test('cached tokens are split out of the input count; legacy token attribute names work', () => {
  otel.ingestTraces(payload([chat({ attrs: [S('gen_ai.conversation.id', 'conv-cache'), I('gen_ai.usage.cache_read.input_tokens', 400)] })]));
  const [p] = store.getPrompts('otel-conv-cache');
  assert.deepEqual([p.input_tokens, p.cache_read_tokens], [600, 400]);

  const legacy = span({ attrs: [S('gen_ai.system', 'openai'), S('gen_ai.request.model', 'gpt-4o'), I('gen_ai.usage.prompt_tokens', 300), I('gen_ai.usage.completion_tokens', 20), S('session.id', 'conv-legacy')] });
  otel.ingestTraces(payload([legacy]));
  const [q] = store.getPrompts('otel-conv-legacy');
  assert.deepEqual([q.input_tokens, q.output_tokens], [300, 20]);
});

test('tool spans attach to their parent chat span, with real duration, ids and error status', () => {
  const parent = chat({ spanId: 'p1'.padStart(16, '0'), start: T0, end: T0 + 3000, attrs: [S('gen_ai.conversation.id', 'conv-tools')] });
  const t1 = tool({ parent: parent.spanId, start: T0 + 3000, end: T0 + 3400, callId: 'call_a' });
  const t2 = tool({ parent: parent.spanId, start: T0 + 3400, end: T0 + 3500, callId: 'call_b', tool: 'bash', error: true, args: '{"cmd":"false"}', result: 'exit 1' });
  const r = otel.ingestTraces(payload([t2, t1, parent].map(s => ({ ...s, attributes: s.attributes.map(a => a) })).map(s => s)));
  assert.equal(r.toolCalls, 2);
  const [turn] = store.getPrompts('otel-conv-tools');
  assert.equal(turn.tool_call_count, 2);
  const calls = store.getToolCalls(turn.id);
  assert.deepEqual(calls.map(c => [c.name, c.tool_use_id, c.duration_ms]), [['read_file', 'call_a', 400], ['bash', 'call_b', 100]], 'ordered by start time even though sent out of order');
  assert.equal(calls[0].output, 'contents');
  assert.equal(calls[1].is_error, 1);
  assert.equal(calls[0].is_error, null);
});

test('a tool span without a parent joins the latest chat of its trace, or of the session when sent later', () => {
  const traceId = 'b'.repeat(32);
  const c = chat({ traceId, start: T0 + 10_000, end: T0 + 11_000, attrs: [S('gen_ai.conversation.id', 'conv-late')] });
  otel.ingestTraces(payload([c, tool({ traceId, start: T0 + 11_000, end: T0 + 11_200, attrs: [S('gen_ai.conversation.id', 'conv-late')], callId: 'same-trace' })]));
  // a later batch (a different trace, same conversation) has only the tool span
  otel.ingestTraces(payload([tool({ traceId: 'c'.repeat(32), start: T0 + 20_000, end: T0 + 20_100, attrs: [S('gen_ai.conversation.id', 'conv-late')], callId: 'next-batch' })]));
  const [turn] = store.getPrompts('otel-conv-late');
  assert.deepEqual(store.getToolCalls(turn.id).map(c => c.tool_use_id), ['same-trace', 'next-batch']);
});

test('prompt text is read from gen_ai.input.messages or a user-message event', () => {
  const msgs = JSON.stringify([{ role: 'system', content: 'be nice' }, { role: 'user', content: 'fix the parser' }]);
  otel.ingestTraces(payload([chat({ attrs: [S('gen_ai.conversation.id', 'conv-text1'), S('gen_ai.input.messages', msgs)] })]));
  assert.equal(store.getPrompts('otel-conv-text1')[0].input_text, 'fix the parser');
  const ev = span({ attrs: [S('gen_ai.operation.name', 'chat'), I('gen_ai.usage.input_tokens', 5), S('gen_ai.conversation.id', 'conv-text2')], events: [{ name: 'gen_ai.user.message', attributes: [S('content', 'hello there')] }] });
  otel.ingestTraces(payload([ev]));
  assert.equal(store.getPrompts('otel-conv-text2')[0].input_text, 'hello there');
});

test('sessions: one conversation across traces is one session; without an id each trace is its own', () => {
  otel.ingestTraces(payload([chat({ traceId: '1'.repeat(32), attrs: [S('gen_ai.conversation.id', 'conv-multi')] })]));
  otel.ingestTraces(payload([chat({ traceId: '2'.repeat(32), start: T0 + 5000, attrs: [S('gen_ai.conversation.id', 'conv-multi')] })]));
  // no prompt text here, so the two model calls group as one turn (see #74); both are stored
  assert.equal(store.getPrompts('otel-conv-multi')[0].request_count, 2);
  otel.ingestTraces(payload([chat({ traceId: '3'.repeat(32) })]));
  otel.ingestTraces(payload([chat({ traceId: '4'.repeat(32) })]));
  assert.ok(session('otel-' + '3'.repeat(32)) && session('otel-' + '4'.repeat(32)));
});

test('non-GenAI spans are ignored, a turn_finished event is emitted, process.working_directory sets the project', () => {
  const seen = [];
  const off = events.subscribe(e => e.type === 'turn_finished' && seen.push(e.data));
  const http = span({ name: 'GET /x', attrs: [S('http.method', 'GET')] });
  const r = otel.ingestTraces(payload([http, chat({ attrs: [S('gen_ai.conversation.id', 'conv-evt')] })], 'svc', [S('process.working_directory', '/work/demo')]));
  off();
  assert.equal(r.skipped, 1);
  assert.equal(seen.length, 1);
  assert.equal(session('otel-conv-evt').project_path, '/work/demo');
});

test('a tool span with no model call around it still gets stored', () => {
  otel.ingestTraces(payload([tool({ attrs: [S('gen_ai.conversation.id', 'conv-solo')], callId: 'solo' })]));
  const [turn] = store.getPrompts('otel-conv-solo');
  assert.equal(store.getToolCalls(turn.id)[0].tool_use_id, 'solo');
});

test('malformed payloads are rejected by the mapper with a clear error', () => {
  for (const bad of [null, [], 'x', {}, { resourceSpans: 'no' }, { resourceSpans: [null] }, { resourceSpans: [{ scopeSpans: [{ spans: [{ name: 'no ids' }] }] }] }]) {
    assert.throws(() => mapper.mapTraces(bad), mapper.OtlpError, JSON.stringify(bad));
  }
  assert.deepEqual(mapper.mapTraces({ resourceSpans: [] }), { spans: [], skipped: 0 });
});

// ── the route, against a real daemon ──
const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const auth = () => ({ authorization: `Bearer ${token}` });

test('POST /v1/traces needs the install token, then stores spans and answers with an empty OTLP response', async () => {
  const body = payload([chat({ attrs: [S('gen_ai.conversation.id', 'route-1')] })]);
  assert.equal((await post('/v1/traces', body)).status, 401);
  assert.equal((await post('/v1/traces', body, { authorization: 'Bearer wrong' })).status, 401);
  const ok = await post('/v1/traces', body, auth());
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), {});
  const sessions = await (await fetch(base + '/api/sessions')).json();
  assert.equal(sessions.find(s => s.id === 'otel-route-1').total_input_tokens, 1000);
});

test('malformed or unsupported payloads get 400/415 and the daemon keeps running', async () => {
  assert.equal((await post('/v1/traces', '{not json', auth())).status, 400);
  const wrongShape = await post('/v1/traces', { hello: 'world' }, auth());
  assert.equal(wrongShape.status, 400);
  assert.match((await wrongShape.json()).error, /resourceSpans/);
  assert.equal((await post('/v1/traces', { resourceSpans: [{ scopeSpans: [{ spans: [{}] }] }] }, auth())).status, 400);
  const proto = await fetch(base + '/v1/traces', { method: 'POST', headers: { 'content-type': 'application/x-protobuf', ...auth() }, body: new Uint8Array([8, 1]) });
  assert.equal(proto.status, 415);
  assert.match((await proto.json()).error, /http\/json/);
  assert.equal((await fetch(base + '/api/health')).status, 200, 'still alive');
});

test('a foreign origin is refused like the rest of the API', async () => {
  assert.equal((await post('/v1/traces', payload([]), { ...auth(), origin: 'https://evil.example' })).status, 403);
});
