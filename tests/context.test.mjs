import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeContext, diffContext } from '../daemon/context.js';

const req = (messages, extra = {}) => ({ system: 'S'.repeat(100), tools: [{ name: 'Read', description: 'x'.repeat(50) }], messages, ...extra });
const reminder = '<system-reminder>Contents of /p/CLAUDE.md: ' + 'c'.repeat(200) + '</system-reminder>';

const turn1 = req([
  { role: 'user', content: [{ type: 'text', text: reminder }, { type: 'text', text: 'fix it' }] },
]);
const turn2 = req([
  ...turn1.messages,
  { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.js' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'R'.repeat(5000) }] },
]);

test('analyzeContext splits chars into sections', () => {
  const a = analyzeContext(turn1);
  assert.equal(a.sections.system, 100);
  assert.ok(a.sections.tools > 50);
  assert.ok(a.sections.claude_md >= 200, 'CLAUDE.md reminder is its own section');
  assert.equal(a.sections.history, 'fix it'.length);
  assert.equal(a.sections.tool_results, 0);
  assert.equal(a.message_count, 1);
});

test('analyzeContext counts tool results separately and names them from the tool_use', () => {
  const a = analyzeContext(turn2);
  assert.equal(a.sections.tool_results, 5000);
  assert.equal(a.messages[2].k, 'tool_result');
  assert.equal(a.messages[2].n, 'Read');
  assert.equal(a.messages[2].m, 5000);
});

test('analyzeContext handles array system prompts, string content and junk without throwing', () => {
  assert.equal(analyzeContext({ system: [{ type: 'text', text: 'abc' }], messages: [{ role: 'user', content: 'hi' }] }).sections.system, 3);
  assert.equal(analyzeContext({}).message_count, 0);
});

test('diffContext reports growth, added messages and the largest new tool result', () => {
  const d = diffContext(analyzeContext(turn1), analyzeContext(turn2));
  assert.equal(d.added_messages, 2);
  assert.equal(d.delta.tool_results, 5000);
  assert.equal(d.delta.system, 0);
  assert.deepEqual(d.largest_tool_result, { name: 'Read', chars: 5000 });
  assert.equal(d.compacted, false);
});

test('diffContext flags compaction when history shrinks, and has no diff for the first turn', () => {
  const d = diffContext(analyzeContext(turn2), analyzeContext(turn1));
  assert.equal(d.compacted, true);
  assert.equal(diffContext(null, analyzeContext(turn1)), null);
});
