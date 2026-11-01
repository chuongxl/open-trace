import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeRule, describePreview } from './overlay.js'

test('describeRule summarises each kind', () => {
  assert.equal(describeRule({ kind: 'append_user_message', params: { text: 'be careful' } }), 'Inject: “be careful”')
  assert.match(describeRule({ kind: 'append_user_message', params: { text: 'x'.repeat(200) } }), /…”$/)
  assert.equal(describeRule({ kind: 'truncate_tool_result', params: { max_chars: 500 } }), 'Trim results to 500 characters (all)')
  assert.equal(describeRule({ kind: 'delete_message', params: { indices: [3, 4] } }), 'Delete messages 3, 4')
  assert.equal(describeRule({ kind: 'replace_message', params: { index: 2 } }), 'Replace message 2')
})

test('describePreview shows problems, or sizes and the one-time equiv. cost', () => {
  const fmt = (n) => `$${n.toFixed(2)}`
  assert.equal(describePreview({ valid: false, problems: ['a', 'b'] }, fmt), 'Not valid: a; b')
  assert.equal(
    describePreview({ valid: true, messages_before: 5, messages_after: 6, cache: { tokens: 1200, extra_equiv_cost_usd: 0.0123 } }, fmt),
    'Valid · 5 → 6 messages · re-caches ~1200 tokens, ~$0.01 extra equiv. cost (one-time)',
  )
  assert.equal(describePreview({ valid: true, messages_before: 5, messages_after: 6, cache: { tokens: 0, extra_equiv_cost_usd: 0 } }, fmt), 'Valid · 5 → 6 messages')
})
