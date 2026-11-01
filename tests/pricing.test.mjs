// Rates from platform.claude.com/docs/en/about-claude/pricing (checked 2026-11-01).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost, PRICING } from '../daemon/pricing/models.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !== ${b}`);
const M = 1_000_000;
// 1M tokens of each kind, so the cost is the sum of the four rates.
const all = { input_tokens: M, output_tokens: M, cache_read_tokens: M, cache_write_tokens: M };

test('current models are priced from the published table', () => {
  near(estimateCost('claude-fable-5-1', all), 10 + 50 + 0.25 + 12.5);
  near(estimateCost('claude-fable-5', all), 10 + 50 + 1 + 12.5);
  near(estimateCost('claude-opus-5-5', all), 4 + 20 + 0.2 + 5);
  near(estimateCost('claude-opus-5', all), 5 + 25 + 0.5 + 6.25);
  near(estimateCost('claude-sonnet-5-5', all), 2 + 10 + 0.1 + 2.5);
  near(estimateCost('claude-sonnet-5', all), 2 + 10 + 0.2 + 2.5);
  near(estimateCost('claude-haiku-4-5', all), 1 + 5 + 0.1 + 1.25);
});

test('a more specific model id is never swallowed by a shorter prefix, dated ids still match', () => {
  assert.notEqual(estimateCost('claude-opus-5-5-20261001', all), estimateCost('claude-opus-5', all));
  assert.equal(estimateCost('claude-opus-5-5-20261001', all), estimateCost('claude-opus-5-5', all));
  const keys = Object.keys(PRICING);
  for (const [i, k] of keys.entries()) {
    for (const longer of keys.slice(i + 1)) assert.ok(!longer.startsWith(k) || longer === k, `${k} listed before the more specific ${longer}`);
  }
});

test('Haiku 5.5 is priced per request by prompt length, counting cache tokens', () => {
  const small = { input_tokens: 50_000, output_tokens: 1_000, cache_read_tokens: 50_000 }; // 100,000: not over
  near(estimateCost('claude-haiku-5-5', small), 50_000 / M * 0.10 + 1_000 / M * 0.50 + 50_000 / M * 0.01);
  const big = { input_tokens: 50_000, output_tokens: 1_000, cache_read_tokens: 50_001 };   // 100,001: over
  near(estimateCost('claude-haiku-5-5', big), 50_000 / M * 0.50 + 1_000 / M * 2.50 + 50_001 / M * 0.05);
  near(estimateCost('claude-haiku-5-5', { cache_write_tokens: 200_000 }), 200_000 / M * 0.625);
});

test('an unpriced model uses the fallback and warns once', () => {
  const seen = [];
  const orig = console.warn; console.warn = (m) => seen.push(m);
  try {
    estimateCost('claude-haiku-9-9', all); estimateCost('claude-haiku-9-9', all);
  } finally { console.warn = orig; }
  assert.equal(seen.length, 1);
  assert.match(seen[0], /claude-haiku-9-9/);
});

test('gpt-4o-mini is not priced as gpt-4o', () => {
  assert.ok(estimateCost('gpt-4o-mini', all) < estimateCost('gpt-4o', all) / 5);
});
