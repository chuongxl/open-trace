import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estTokens, barSegments, describeDelta } from './context.js'

const fmt = (n) => String(n)

test('estTokens is chars/4 rounded', () => {
  assert.equal(estTokens(4000), 1000)
  assert.equal(estTokens(5), 1)
})

test('barSegments scale against the largest turn and keep section order', () => {
  const segs = barSegments({ system: 100, tools: 100, claude_md: 0, history: 200, tool_results: 0 }, 400)
  assert.deepEqual(segs.map((s) => s.key), ['system', 'tools', 'claude_md', 'history', 'tool_results'])
  assert.equal(segs[3].pct, 50)
  assert.equal(barSegments({}, 0)[0].pct, 0)
})

test('describeDelta lists changed sections largest first, with signs', () => {
  assert.equal(describeDelta({ system: 0, tools: 0, claude_md: 0, history: 40, tool_results: 4000 }, fmt), '+~1000 tool results, +~10 conversation')
  assert.equal(describeDelta({ system: 0, tools: 0, claude_md: 0, history: -80, tool_results: 0 }, fmt), '−~20 conversation')
  assert.equal(describeDelta(null, fmt), '')
})
