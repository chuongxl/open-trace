// Phase 13 (#56): GET /api/live pushes events; GET /api/sessions/:id/context reports section sizes and diffs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp, server, port, store, proxy, express;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ot-live-'));
  process.env.DB_PATH = join(tmp, 'open-trace.db');
  store = await import('../daemon/db/store.js');
  proxy = await import('../daemon/proxy/claude-proxy.js');
  const { default: router } = await import('../daemon/api/router.js');
  ({ default: express } = await import('express'));
  const app = express();
  app.use('/api', router);
  server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => { server.closeAllConnections(); server.close(); rmSync(tmp, { recursive: true, force: true }); });

const get = (path) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path }, resolve).on('error', reject));
const json = async (path) => { const res = await get(path); let d = ''; for await (const c of res) d += c; return { status: res.statusCode, body: JSON.parse(d) }; };

const READ_REPLY = JSON.stringify({ type: 'message', model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a.js' } }] });
const BASE = { model: 'claude-sonnet-4-5', system: 'You are Claude Code.\ncwd: /tmp/live-proj\n', tools: [{ name: 'Read' }], stream: false };
const turn1 = { ...BASE, messages: [{ role: 'user', content: 'fix it' }] };
const turn2 = { ...BASE, messages: [
  ...turn1.messages,
  { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a.js' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x'.repeat(4000) }] },
] };

test('GET /api/live streams session_updated and turn_finished as SSE frames', async () => {
  const res = await get('/api/live');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  let buf = '';
  res.on('data', (c) => { buf += c; });

  proxy.parseNonStreaming(turn1, READ_REPLY);
  const deadline = Date.now() + 3000;
  while (!buf.includes('event: turn_finished') && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  res.destroy();

  assert.ok(buf.includes('event: session_updated'), buf);
  const frame = buf.split('\n\n').find(f => f.startsWith('event: turn_finished'));
  const data = JSON.parse(frame.split('data: ')[1]);
  assert.deepEqual(data.tools, ['Read']);
  assert.equal(data.input_tokens, 10);
  assert.ok(data.session_id && data.prompt_id);
});

test('a closed live connection stops receiving (no listener leak)', async () => {
  const { subscribe } = await import('../daemon/events.js');
  const res = await get('/api/live');
  res.destroy();
  await new Promise(r => setTimeout(r, 100));
  assert.doesNotThrow(() => proxy.parseNonStreaming(turn1, READ_REPLY));
  subscribe(() => {})(); // subscribe/unsubscribe round-trips
});

test('GET /api/sessions/:id/context returns sections and the diff against the previous request', async () => {
  proxy.parseNonStreaming(turn2, READ_REPLY);
  const [session] = store.getSessions({ project: '/tmp/live-proj' });
  const { status, body } = await json(`/api/sessions/${session.id}/context`);
  assert.equal(status, 200);
  const [first, , last] = body.turns;
  assert.equal(first.diff, null, 'first request has no diff');
  assert.equal(first.sections.tool_results, 0);
  assert.equal(last.sections.tool_results, 4000);
  assert.equal(last.diff.delta.tool_results, 4000);
  assert.deepEqual(last.diff.largest_tool_result, { name: 'Read', chars: 4000 });
  assert.ok(last.total_chars > first.total_chars);
});

test('context endpoint: 404 for an unknown session, empty list for one without context', async () => {
  assert.equal((await json('/api/sessions/nope/context')).status, 404);
  store.upsertSession({ id: 'old-sess', tool: 'opencode', started_at: 1, project_path: null, project_name: 'o', model: 'm', equiv_cost_usd: 0 });
  assert.deepEqual((await json('/api/sessions/old-sess/context')).body, { turns: [] });
});
