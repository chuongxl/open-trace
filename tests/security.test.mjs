// Local API guard (#62): foreign origins/hosts are refused, mutating calls need the install token.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
let tmp, port, child, out = '';

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ot-sec-'));
  child = spawn(process.execPath, [join(REPO, 'daemon', 'index.js')], {
    cwd: REPO,
    env: { ...process.env, DB_PATH: join(tmp, 'open-trace.db'), OPENCODE_DB_PATH: join(tmp, 'none.db'), DAEMON_PORT: '0', CLAUDE_PROXY_PORT: '0', COPILOT_PROXY_PORT: '0' },
  });
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !port) {
    port = out.match(/Dashboard at http:\/\/localhost:(\d+)/)?.[1];
    await new Promise(r => setTimeout(r, 200));
  }
  assert.ok(port, 'daemon did not start: ' + out.slice(-800));
});
after(() => { child?.kill('SIGTERM'); rmSync(tmp, { recursive: true, force: true }); });

// node:http so we can set a spoofed Host header (fetch forbids it)
const call = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, method, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
    let data = ''; res.on('data', c => { data += c; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
  });
  req.on('error', reject);
  req.end(body);
});

const optBody = JSON.stringify({ prompt_id: 'nope', original_prompt: 'a', optimized_prompt: 'b' });
const post = (headers) => call('/api/optimizations', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: optBody });

test('same-origin read works and the token file is private', async () => {
  assert.equal((await call('/api/health')).status, 200);
  assert.equal(statSync(join(tmp, 'token')).mode & 0o077, 0, 'token file is owner-only');
});

test('foreign origin is rejected and gets no CORS grant', async () => {
  const r = await call('/api/sessions', { headers: { Origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  assert.equal(r.headers['access-control-allow-origin'], undefined);
});

test('the dev server origin is granted CORS; same-origin needs none', async () => {
  const dev = await call('/api/health', { headers: { Origin: 'http://localhost:5173' } });
  assert.equal(dev.headers['access-control-allow-origin'], 'http://localhost:5173');
  assert.equal((await call('/api/health', { headers: { Origin: `http://localhost:${port}` } })).status, 200);
});

test('a rebound Host header is rejected', async () => {
  assert.equal((await call('/api/health', { headers: { Host: `evil.example:${port}` } })).status, 403);
  assert.equal((await call('/api/health', { headers: { Host: 'localhost' } })).status, 403, 'wrong port');
});

test('mutating call without or with a wrong token returns 401', async () => {
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ Authorization: 'Bearer wrong' })).status, 401);
});

test('mutating call with the token passes the guard; the token is served to the dashboard only', async () => {
  const { token } = JSON.parse((await call('/api/token')).body);
  assert.equal(token, readFileSync(join(tmp, 'token'), 'utf8').trim());
  assert.notEqual((await post({ Authorization: `Bearer ${token}` })).status, 401);
  assert.equal((await call('/api/token', { headers: { Origin: 'https://evil.example' } })).status, 403);
});
