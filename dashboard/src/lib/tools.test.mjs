import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TOOLS, hasContext, canControl } from './tools.js'

test('context inspector for proxied tools, debugger controls for Claude Code only', () => {
  for (const t of ['claude-code', 'aider', 'continue', 'cline', 'roo-code', 'openai-compat']) assert.equal(hasContext(t), true, t)
  for (const t of ['opencode', 'copilot', 'unknown']) assert.equal(hasContext(t), false, t)
  assert.deepEqual(Object.keys(TOOLS).filter(canControl), ['claude-code'])
})
