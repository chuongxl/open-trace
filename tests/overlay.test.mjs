import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRules, validateRequest, checkRule, editsFrom, cacheImpact } from '../daemon/overlay.js';

const tu = (id) => ({ type: 'tool_use', id, name: 'Read', input: { file_path: 'a' } });
const tr = (id, content) => ({ type: 'tool_result', tool_use_id: id, content });
const body = () => ({
  model: 'claude-sonnet-4-5',
  messages: [
    { role: 'user', content: 'fix the bug' },
    { role: 'assistant', content: [{ type: 'text', text: 'looking' }, tu('t1')] },
    { role: 'user', content: [tr('t1', 'X'.repeat(1000))] },
    { role: 'assistant', content: [{ type: 'text', text: 'found it' }] },
  ],
});
const rule = (id, kind, params, anchor = null) => ({ id, kind, params, anchor });

test('the input body is never mutated and no rules is a no-op', () => {
  const b = body(); const snapshot = JSON.stringify(b);
  const r = applyRules(b, [rule(1, 'replace_message', { index: 0, text: 'changed' })]);
  assert.equal(JSON.stringify(b), snapshot);
  assert.equal(applyRules(b, []).body.messages.length, 4);
  assert.notEqual(r.body.messages[0].content, 'fix the bug');
});

test('append_user_message after an assistant message adds a user message', () => {
  const r = applyRules(body(), [rule(1, 'append_user_message', { text: 'do not touch the db' })]);
  assert.equal(r.body.messages.length, 5);
  assert.deepEqual(r.body.messages[4], { role: 'user', content: [{ type: 'text', text: 'do not touch the db' }] });
  assert.equal(r.effects[0].anchor, 4, 'anchored to the end of the history at first use');
  assert.deepEqual(r.problems, []);
});

test('append_user_message after a tool_result merges into that user message, tool_result first', () => {
  const b = body(); b.messages.pop(); // history ends with the tool_result message
  const r = applyRules(b, [rule(1, 'append_user_message', { text: 'be careful' })]);
  assert.equal(r.body.messages.length, 3);
  const last = r.body.messages[2].content;
  assert.equal(last[0].type, 'tool_result');
  assert.deepEqual(last[1], { type: 'text', text: 'be careful' });
});

test('an anchored injection stays at the same point as the history grows, and index rules ignore it', () => {
  const grown = body();
  grown.messages.push({ role: 'user', content: 'thanks, now the tests' }, { role: 'assistant', content: 'ok' });
  const r = applyRules(grown, [
    rule(1, 'append_user_message', { text: 'GUIDE' }, 4),
    rule(2, 'replace_message', { index: 4, text: 'now the tests please' }),
  ]);
  const m = r.body.messages;
  assert.equal(m[3].role, 'assistant');
  assert.equal(m[4].content[0].text, 'GUIDE', 'injected right after original message 3');
  assert.equal(m[5].content, 'now the tests please', 'index 4 still means the client\'s message 4');
});

test('replace_message refuses messages with tool calls, results or thinking', () => {
  for (const index of [1, 2]) {
    const r = applyRules(body(), [rule(1, 'replace_message', { index, text: 'x' })]);
    assert.equal(r.effects[0].ok, false);
    assert.equal(r.body.messages[index].content.length > 0, true);
  }
  const b = body(); b.messages[3].content.unshift({ type: 'thinking', thinking: 't', signature: 's' });
  assert.equal(applyRules(b, [rule(1, 'replace_message', { index: 3, text: 'x' })]).effects[0].ok, false);
});

test('truncate_tool_result cuts one result by id or all, keeping the pairing and is_error', () => {
  const r = applyRules(body(), [rule(1, 'truncate_tool_result', { max_chars: 100, tool_use_id: 't1' })]);
  const out = r.body.messages[2].content[0];
  assert.ok(out.content.startsWith('X'.repeat(100)));
  assert.match(out.content, /truncated by open-trace: 900 characters removed/);
  assert.equal(out.tool_use_id, 't1');
  assert.deepEqual(r.problems, []);
  assert.equal(applyRules(body(), [rule(1, 'truncate_tool_result', { max_chars: 5000 })]).effects[0].ok, false, 'nothing longer than the limit');
  const arr = body(); arr.messages[2].content[0].content = [{ type: 'text', text: 'Y'.repeat(300) }, { type: 'image', source: {} }];
  const t = applyRules(arr, [rule(1, 'truncate_tool_result', { max_chars: 50 })]).body.messages[2].content[0].content;
  assert.equal(t[1].type, 'image', 'non-text blocks untouched');
});

test('delete_message: a lone tool call is rejected by the validator, a call plus its result is fine', () => {
  const bad = applyRules(body(), [rule(1, 'delete_message', { indices: [1] })]);
  assert.ok(bad.problems.some(p => /tool (call|result)/.test(p)), bad.problems.join('; '));
  assert.equal(bad.body.messages.length, 4, 'invalid edit falls back to the original body');
  const good = applyRules(body(), [rule(1, 'delete_message', { indices: [1, 2] })]);
  assert.deepEqual(good.problems, []);
  assert.equal(good.body.messages.length, 2);
});

test('thinking blocks are never deleted or edited', () => {
  const b = body(); b.messages[1].content.unshift({ type: 'thinking', thinking: 'hmm', signature: 'sig' });
  const r = applyRules(b, [rule(1, 'delete_message', { indices: [1, 2] })]);
  assert.equal(r.effects[0].ok, false);
  assert.deepEqual(r.body.messages[1].content[0], { type: 'thinking', thinking: 'hmm', signature: 'sig' });
  const tampered = body(); tampered.messages[1].content.unshift({ type: 'thinking', thinking: 'hmm', signature: 'sig' });
  const orig = structuredClone(tampered); tampered.messages[1].content[0].thinking = 'edited';
  assert.ok(validateRequest(tampered, orig).some(p => /thinking/.test(p)));
});

test('validateRequest catches the shapes the API would reject', () => {
  assert.ok(validateRequest({ messages: [] }).length);
  assert.ok(validateRequest({ messages: [{ role: 'assistant', content: 'x' }] }).some(p => /start with a user/.test(p)));
  assert.ok(validateRequest({ messages: [{ role: 'user', content: '' }] }).some(p => /empty/.test(p)));
  assert.deepEqual(validateRequest(body()), []);
});

test('checkRule validates parameters per kind', () => {
  assert.deepEqual(checkRule('append_user_message', { text: 'hi' }), []);
  assert.ok(checkRule('append_user_message', { text: '  ' }).length);
  assert.ok(checkRule('nope', {}).length);
  assert.ok(checkRule('replace_message', { index: -1, text: 'x' }).length);
  assert.ok(checkRule('truncate_tool_result', { max_chars: 'a' }).length);
  assert.ok(checkRule('delete_message', { indices: [] }).length);
});

test('cacheImpact estimates the one-time cache re-write from the first edited message', () => {
  const b = body();
  assert.equal(editsFrom(rule(1, 'replace_message', { index: 1, text: 'x' }), b), 1);
  assert.equal(editsFrom(rule(1, 'delete_message', { indices: [3, 2] }), b), 2);
  assert.equal(editsFrom(rule(1, 'append_user_message', { text: 'x' }), b), 3);
  assert.equal(editsFrom(rule(1, 'truncate_tool_result', { max_chars: 10 }), b), 2);
  assert.equal(editsFrom(rule(1, 'truncate_tool_result', { max_chars: 99999 }), b), null);
  const early = cacheImpact(b, 0), late = cacheImpact(b, 3);
  assert.ok(early.tokens > late.tokens);
  assert.ok(early.extra_equiv_cost_usd > late.extra_equiv_cost_usd && late.extra_equiv_cost_usd > 0);
  assert.equal(cacheImpact(b, null).extra_equiv_cost_usd, 0);
});
