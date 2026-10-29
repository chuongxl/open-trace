// Regression test for issue #61: with a built dashboard present the daemon must
// start (Express 5 rejects a bare '*' route) and serve index.html for SPA routes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = '<!doctype html><title>spa-marker</title>';

let tmp, api, child, out = '';

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ot-spa-'));
  const dist = join(tmp, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), MARKER);

  child = spawn(process.execPath, [join(REPO, 'daemon', 'index.js')], {
    cwd: REPO,
    env: { ...process.env, DB_PATH: join(tmp, 'open-trace.db'), OPENCODE_DB_PATH: join(tmp, 'missing.db'), DASHBOARD_DIST: dist, DAEMON_PORT: '0', CLAUDE_PROXY_PORT: '0', COPILOT_PROXY_PORT: '0' },
  });
  child.stdout.on('data', d => { out += d.toString(); });
  child.stderr.on('data', d => { out += d.toString(); });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const m = out.match(/Dashboard at http:\/\/localhost:(\d+)/);
    if (m) { api = 'http://' + '127.0.0.1:' + m[1]; break; }
    await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(api, 'daemon failed to start with a built dashboard: ' + out.slice(-800));
});

after(() => { child?.kill('SIGTERM'); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

test('unknown non-API paths and the root serve index.html', async () => {
  for (const path of ['/', '/projects/abc', '/sessions/x/y']) {
    const res = await fetch(api + path);
    assert.equal(res.status, 200, path);
    assert.equal(await res.text(), MARKER, path);
  }
});

test('API routes are not shadowed by the fallback', async () => {
  const res = await fetch(api + '/api/health');
  assert.equal((await res.json()).status, 'ok');
});
