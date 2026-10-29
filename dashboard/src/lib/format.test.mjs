import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shortenHomePath, costTier, formatTokenCount, tokenProportions } from './format.js'

test('shortenHomePath replaces a leading home directory with ~', () => {
  assert.equal(shortenHomePath('/Users/chuong/github-me/open-trace'), '~/github-me/open-trace')
  assert.equal(shortenHomePath('/home/alice/proj'), '~/proj')
  assert.equal(shortenHomePath('/var/data/proj'), '/var/data/proj')
  assert.equal(shortenHomePath(''), '')
})

test('costTier buckets cost into green/yellow/red', () => {
  assert.equal(costTier(0), 'green')
  assert.equal(costTier(0.99), 'green')
  assert.equal(costTier(1), 'yellow')
  assert.equal(costTier(9.99), 'yellow')
  assert.equal(costTier(10), 'red')
  assert.equal(costTier(42), 'red')
})

test('formatTokenCount abbreviates large numbers', () => {
  assert.equal(formatTokenCount(500), '500')
  assert.equal(formatTokenCount(1500), '1.5k')
  assert.equal(formatTokenCount(1000), '1k')
  assert.equal(formatTokenCount(2500000), '2.5m')
})

test('tokenProportions computes percentages and handles zero total', () => {
  assert.deepEqual(tokenProportions({ input: 50, output: 30, cache: 20 }), {
    inputPct: 50, outputPct: 30, cachePct: 20,
  })
  assert.deepEqual(tokenProportions({ input: 0, output: 0, cache: 0 }), {
    inputPct: 0, outputPct: 0, cachePct: 0,
  })
})
