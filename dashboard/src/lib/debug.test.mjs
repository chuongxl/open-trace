import { test } from 'node:test'
import assert from 'node:assert/strict'
import { availableActions } from './debug.js'

test('controls follow the session state', () => {
  assert.deepEqual(availableActions('running', 0), { pause: true, step: false, continue: false, stop: true })
  assert.deepEqual(availableActions('pausing', 0), { pause: false, step: false, continue: true, stop: true })
  assert.deepEqual(availableActions('paused', 1), { pause: false, step: true, continue: true, stop: true })
  assert.deepEqual(availableActions('stopping', 0), { pause: false, step: false, continue: true, stop: false }, 'Continue cancels an armed stop')
})
