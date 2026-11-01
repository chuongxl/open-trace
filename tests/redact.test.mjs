import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedactor } from '../daemon/redact.js';

const redact = createRedactor();
// Fixtures are assembled at runtime so no secret-shaped literal sits in the repo.
const rep = (c, n) => c.repeat(n);
const SAMPLES = {
  'anthropic-key': 'sk-ant-' + 'api03-' + rep('A', 40),
  'api-key': 'sk-' + 'proj-' + rep('b', 30),
  'github-token': 'ghp_' + rep('c', 36),
  'aws-key': 'AKIA' + rep('D', 16),
  'google-key': 'AIza' + rep('e', 35),
  'slack-token': 'xoxb-' + rep('1', 12) + '-' + rep('f', 12),
  'stripe-key': 'sk_live_' + rep('g', 24),
  'jwt': 'eyJ' + rep('h', 12) + '.eyJ' + rep('i', 12) + '.' + rep('j', 12),
};

test('known token formats are replaced, with the kind in the marker', () => {
  for (const [kind, secret] of Object.entries(SAMPLES)) {
    const out = redact(`before ${secret} after`);
    assert.ok(!out.includes(secret), `${kind} leaked: ${out}`);
    assert.ok(out.includes(`[REDACTED:${kind}]`), `${kind} marker missing: ${out}`);
    assert.ok(out.startsWith('before ') && out.endsWith(' after'), 'surrounding text kept');
  }
});

test('Bearer tokens and key=value secrets keep the name and drop the value', () => {
  assert.equal(redact('Authorization: Bearer ' + rep('k', 30)), 'Authorization: Bearer [REDACTED:bearer]');
  assert.equal(redact('API_KEY=' + rep('m', 20)), 'API_KEY=[REDACTED:secret]');
  assert.equal(redact('password: "hunter2hunter2"'), 'password: "[REDACTED:secret]"');
  assert.equal(redact('db_password = ' + rep('n', 12) + ' # prod'), 'db_password = [REDACTED:secret] # prod');
});

test('secrets inside JSON-escaped text (how raw_request is stored) are caught', () => {
  const raw = JSON.stringify({ messages: [{ role: 'user', content: 'use api_key: ' + rep('p', 24) + ' please' }], config: { client_secret: rep('q', 20) } });
  const out = redact(raw);
  assert.ok(!out.includes(rep('p', 24)) && !out.includes(rep('q', 20)), out);
  assert.doesNotThrow(() => JSON.parse(out), 'still valid JSON');
});

test('private key blocks are removed, also when the stored text was cut before the END line', () => {
  const body = rep('Z', 200);
  assert.equal(redact(`a -----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY----- b`), 'a [REDACTED:private-key] b');
  assert.equal(redact(`a -----BEGIN PRIVATE KEY-----\n${body}`), 'a [REDACTED:private-key]');
});

test('ordinary text, counters and flags are left alone', () => {
  const normal = 'Read src/auth/token.js and fix the login flow. {"input_tokens":12345678,"max_tokens":4096,"has_secret":true}';
  assert.equal(redact(normal), normal);
  assert.equal(redact('the password field is required'), 'the password field is required');
  assert.equal(redact(null), null);
  assert.equal(redact(''), '');
});

test('redaction is idempotent', () => {
  const once = redact('key ' + SAMPLES['anthropic-key'] + ' and token=' + rep('r', 20));
  assert.equal(redact(once), once);
});

test('custom patterns apply; invalid ones are ignored; disabled passes everything through', () => {
  const custom = createRedactor({ extraPatterns: ['ACME-\\d{6}', '(unclosed'] });
  assert.equal(custom('ticket ACME-123456 filed'), 'ticket [REDACTED:custom] filed');
  assert.equal(createRedactor({ enabled: false })('sk-ant-' + rep('A', 40)), 'sk-ant-' + rep('A', 40));
});

test('large inputs are fast (no catastrophic backtracking)', () => {
  const big = ('lorem ipsum token dolor sit amet ' + rep('x', 50) + ' \n').repeat(10_000); // ~600 KB
  const t = Date.now();
  redact(big);
  redact(rep('A', 500_000));
  redact('-----BEGIN PRIVATE KEY-----' + rep('\n', 100_000));
  assert.ok(Date.now() - t < 1500, `took ${Date.now() - t} ms`);
});
