// Regression test for issue #53: the proxy must store streamed and non-streamed
// responses. Feeds recorded Anthropic payloads straight into the parsers and
// asserts what lands in SQLite (temp DB, no network).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp, store, proxy;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ot-proxy-'));
  process.env.DB_PATH = join(tmp, 'open-trace.db');
  store = await import('../daemon/db/store.js');
  proxy = await import('../daemon/proxy/claude-proxy.js');
});

after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

const reqBody = (cwd, text) => ({
  model: 'claude-sonnet-4-5',
  stream: true,
  system: 'You are Claude Code.\ncwd: ' + cwd + '\n',
  messages: [{ role: 'user', content: text }],
});

const sse = (...events) => events.map(e => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join('');

const STREAM = sse(
  { type: 'message_start', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading file' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_pa' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'th":"a.js"}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 50 } },
  { type: 'message_stop' },
);

test('streamed response with a tool_use block is stored (session, prompt, tool call)', () => {
  proxy.parseStreamAndStore(reqBody('/tmp/proj-stream', 'fix the bug'), STREAM);

  const [session] = store.getSessions({ project: '/tmp/proj-stream' });
  assert.ok(session, 'session row exists');
  assert.equal(session.tool, 'claude-code');
  assert.equal(session.project_name, 'proj-stream');
  assert.equal(session.total_input_tokens, 100);
  assert.equal(session.total_output_tokens, 50);
  assert.equal(session.total_cache_read, 20);
  assert.equal(session.total_cache_write, 5);

  const [prompt] = store.getPrompts(session.id);
  assert.equal(prompt.input_text, 'fix the bug');
  assert.equal(prompt.model, 'claude-sonnet-4-5');

  const calls = store.getToolCalls(prompt.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'Read');
  assert.deepEqual(JSON.parse(calls[0].input), { file_path: 'a.js' });
});

test('non-streamed response is stored and reuses the session for the same cwd', () => {
  const resp = JSON.stringify({
    type: 'message', model: 'claude-sonnet-4-5',
    usage: { input_tokens: 10, output_tokens: 5 },
    content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'ls' } }],
  });
  proxy.parseNonStreaming({ ...reqBody('/tmp/proj-stream', 'second'), stream: false }, resp);

  const sessions = store.getSessions({ project: '/tmp/proj-stream' });
  assert.equal(sessions.length, 1, 'same cwd within 30 min is one session');
  assert.equal(sessions[0].total_input_tokens, 110);
  const prompts = store.getPrompts(sessions[0].id);
  assert.equal(prompts.length, 2);
  assert.equal(store.getToolCalls(prompts[1].id)[0].name, 'Bash');
});
