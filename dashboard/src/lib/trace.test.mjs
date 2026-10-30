import { test } from 'node:test'
import assert from 'node:assert/strict'
import { displayName, toolKind, summarizeInput, formatDuration, prettyJson, buildTrace } from './trace.js'

test('toolKind classifies mcp, bash and plain tools', () => {
  assert.equal(toolKind('mcp__github__create_issue'), 'mcp')
  assert.equal(toolKind('Bash'), 'bash')
  assert.equal(toolKind('bash'), 'bash')
  assert.equal(toolKind('Read'), 'tool')
  assert.equal(toolKind(undefined), 'tool')
})

test('summarizeInput picks the most telling field and truncates', () => {
  assert.equal(summarizeInput('{"file_path":"src/auth/index.ts","limit":10}'), 'src/auth/index.ts')
  assert.equal(summarizeInput('{"command":"ls -la"}'), 'ls -la')
  assert.equal(summarizeInput('{"query":"open trace"}'), 'open trace')
  assert.equal(summarizeInput('{"weird":"first string value"}'), 'first string value')
  assert.equal(summarizeInput('plain text'), 'plain text')
  assert.equal(summarizeInput(null), '')
  assert.equal(summarizeInput('{}'), '')
  const long = summarizeInput(JSON.stringify({ command: 'x'.repeat(200) }))
  assert.equal(long.length, 81)
  assert.ok(long.endsWith('…'))
})

test('formatDuration', () => {
  assert.equal(formatDuration(312), '312ms')
  assert.equal(formatDuration(1100), '1.1s')
  assert.equal(formatDuration(4200), '4.2s')
  assert.equal(formatDuration(65000), '1m 5s')
})

test('prettyJson formats JSON and passes other text through', () => {
  assert.equal(prettyJson('{"a":1}'), '{\n  "a": 1\n}')
  assert.equal(prettyJson('not json'), 'not json')
  assert.equal(prettyJson(null), '')
})

test('buildTrace: proxy rows (one per call, equal timestamps) keep order and show no timing', () => {
  const prompt = { timestamp: 1000, output_tokens: 50 }
  const rows = [
    { call_order: 1, call_type: 'tool', name: 'Bash', input: '{"command":"ls"}', output: 'a.js', timestamp: 1000, duration_ms: null },
    { call_order: 0, call_type: 'tool', name: 'Read', input: '{"file_path":"a.js"}', output: null, timestamp: 1000, duration_ms: null },
  ]
  const steps = buildTrace(prompt, rows)
  assert.deepEqual(steps.map(s => [s.order, s.name, s.kind]), [[0, 'Read', 'tool'], [1, 'Bash', 'bash']])
  assert.equal(steps[0].output, null)
  assert.equal(steps[1].output, 'a.js')
  assert.ok(steps.every(s => s.startMs === null && s.durationMs === null))
})

test('buildTrace: OpenCode call + result rows merge into one step with duration', () => {
  const prompt = { timestamp: 1000, output_tokens: 10 }
  const rows = [
    { call_order: 0, call_type: 'tool-call', name: 'read_file', input: '{"path":"x"}', output: null, timestamp: 1000 },
    { call_order: 0, call_type: 'tool-result', name: 'read_file', input: null, output: '"data"', timestamp: 1312 },
    { call_order: 1, call_type: 'tool-call', name: 'mcp__web__search', input: '{"query":"q"}', output: null, timestamp: 1000 },
  ]
  const steps = buildTrace(prompt, rows)
  assert.equal(steps.length, 2)
  assert.equal(steps[0].input, '{"path":"x"}')
  assert.equal(steps[0].output, '"data"')
  assert.equal(steps[0].durationMs, 312)
  assert.equal(steps[0].startMs, 0)
  assert.equal(steps[1].kind, 'mcp')
  assert.equal(steps[1].output, null)
})

test('buildTrace: stored duration_ms is used when there is a single row', () => {
  const steps = buildTrace({ timestamp: 5 }, [
    { call_order: 0, call_type: 'tool', name: 'Read', input: null, output: null, timestamp: 5, duration_ms: 120 },
  ])
  assert.equal(steps[0].durationMs, 120)
})

test('buildTrace: no tool calls gives no steps', () => {
  assert.deepEqual(buildTrace({ timestamp: 1 }, []), [])
})

test('displayName shortens MCP tool names only', () => {
  assert.equal(displayName('mcp__github__search_issues'), 'github/search_issues')
  assert.equal(displayName('Read'), 'Read')
})

test('buildTrace: a single proxy call with a measured duration shows timing', () => {
  const steps = buildTrace({ timestamp: 1000 }, [
    { call_order: 0, call_type: 'tool', name: 'Bash', input: null, output: 'ok', timestamp: 2000, duration_ms: 3500 },
  ])
  assert.equal(steps[0].startMs, 1000)
  assert.equal(steps[0].durationMs, 3500)
})
