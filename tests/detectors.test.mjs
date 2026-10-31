// Phase 13c (#57): stuck-agent detectors. Pure rules first, then end to end through the proxy parser.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp, store, proxy, d, stop;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ot-det-'));
  process.env.DB_PATH = join(tmp, 'open-trace.db');
  store = await import('../daemon/db/store.js');
  proxy = await import('../daemon/proxy/claude-proxy.js');
  d = await import('../daemon/detectors.js');
  stop = d.startDetectors();
});
after(() => { stop?.(); rmSync(tmp, { recursive: true, force: true }); });

const call = (id, name, input, extra = {}) => ({ id, name, input, output: null, is_error: 0, ...extra });

test('repeatedCall: N identical calls in a row (newest first), not when interrupted or below N', () => {
  const same = [call('c3', 'Bash', '{"command":"npm test"}'), call('c2', 'Bash', '{"command":"npm test"}'), call('c1', 'Bash', '{"command":"npm test"}')];
  const a = d.repeatedCall(same, 3);
  assert.equal(a.kind, 'repeat_call');
  assert.match(a.message, /Bash called 3× in a row/);
  assert.equal(a.dedupe_key, 'repeat_call:c1', 'keyed by the oldest call of the run, stable as the run grows');
  assert.equal(d.repeatedCall([call('c4', 'Bash', '{"command":"npm test"}'), ...same], 3).dedupe_key, 'repeat_call:c1');
  assert.equal(d.repeatedCall(same, 4), null);
  assert.equal(d.repeatedCall([same[0], call('x', 'Read', '{}'), same[1], same[2]], 3), null, 'interrupted run');
  assert.equal(d.repeatedCall([same[0], call('y', 'Bash', '{"command":"ls"}'), ...same.slice(1)], 3), null, 'same tool, different input');
  assert.equal(d.repeatedCall(same, 0), null, '0 disables');
});

test('repeatedError: the same failing result N times in the window, successes ignored', () => {
  const err = (id) => call(id, 'Bash', '{}', { output: 'Error: ENOENT no such file x.js', is_error: 1 });
  const calls = [err('e3'), call('ok', 'Read', '{}', { output: 'fine' }), err('e2'), err('e1')];
  const a = d.repeatedError(calls, 3);
  assert.equal(a.kind, 'repeat_error');
  assert.match(a.message, /Bash failed 3× with the same error: Error: ENOENT/);
  assert.equal(d.repeatedError(calls, 4), null);
  assert.equal(d.repeatedError([err('a'), call('b', 'Bash', '{}', { output: 'Error: other', is_error: 1 }), err('c')], 3), null, 'different errors do not add up');
  assert.equal(d.repeatedError([call('a', 'Bash', '{}', { output: 'Error: ENOENT', is_error: 0 })], 1), null, 'not flagged is_error');
});

test('contextHigh uses fresh + cached prompt tokens against the window', () => {
  const th = { contextPct: 80, contextWindowTokens: 200000 };
  assert.equal(d.contextHigh({ input_tokens: 100000, cache_read_tokens: 50000 }, th), null);
  const a = d.contextHigh({ input_tokens: 10000, cache_read_tokens: 140000, cache_write_tokens: 15000 }, th);
  assert.match(a.message, /Context at 83% of the window/);
  assert.equal(d.contextHigh({ input_tokens: 999999 }, { ...th, contextPct: 0 }), null, '0 disables');
});

test('costHigh is labeled equiv. cost and fires past the threshold', () => {
  assert.equal(d.costHigh(4.99, 5), null);
  assert.match(d.costHigh(5.5, 5).message, /equiv\. cost \$5\.50 passed the \$5/);
});

// ── end to end: proxy parser -> turn_finished -> detectors -> alerts table ──
const CWD = '/tmp/stuck-proj';
const BASE = { model: 'claude-sonnet-4-5', system: `You are Claude Code.\ncwd: ${CWD}\n`, stream: false };
const reply = (id) => JSON.stringify({ type: 'message', model: BASE.model, usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }] });

test('a looping, failing agent raises one alert per condition, not one per turn', () => {
  let messages = [{ role: 'user', content: 'make tests pass' }];
  for (let i = 1; i <= 5; i++) {
    proxy.parseNonStreaming({ ...BASE, messages }, reply(`tu${i}`), { startedAt: i * 1000, endedAt: i * 1000 + 100 });
    messages = [...messages,
      { role: 'assistant', content: [{ type: 'tool_use', id: `tu${i}`, name: 'Bash', input: { command: 'npm test' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu${i}`, is_error: true, content: 'Error: 3 tests failed' }] }];
  }
  const [session] = store.getSessions({ project: CWD });
  const alerts = store.getAlerts(session.id);
  assert.deepEqual(alerts.map(a => a.kind).sort(), ['repeat_call', 'repeat_error']);
  assert.equal(store.getRecentToolCalls(session.id, 1)[0].output, null, 'newest call has no result yet');
  assert.equal(store.getRecentToolCalls(session.id, 5)[1].is_error, 1, 'tool_result is_error is stored');
});

test('alerts are pushed on the event bus as they are raised', async () => {
  const { subscribe } = await import('../daemon/events.js');
  const seen = [];
  const off = subscribe((e) => e.type === 'alert' && seen.push(e.data));
  const th = { repeatCalls: 0, repeatErrors: 0, contextPct: 50, contextWindowTokens: 1000, costUsd: 0 };
  store.upsertSession({ id: 'alert-sess', tool: 'claude-code', started_at: 1, project_path: null, project_name: 'a', model: 'm', equiv_cost_usd: 0 });
  const raised = d.evaluateTurn({ session_id: 'alert-sess', input_tokens: 800 }, th);
  assert.equal(raised.length, 1);
  assert.equal(d.evaluateTurn({ session_id: 'alert-sess', input_tokens: 900 }, th).length, 0, 'deduped');
  off();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'context_high');
});
