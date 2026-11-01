// A DB created before tool_use_id existed must gain the column (and keep its rows) on open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { SCHEMA } from '../daemon/db/schema.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

test('opening an old database adds tool_use_id (#54) and prompt timing (#75, #56, #57) without losing rows', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ot-migrate-'));
  try {
    const dbPath = join(tmp, 'old.db');
    const old = new Database(dbPath);
    old.pragma('foreign_keys = OFF');
    // The real schema as it was before this change: current SCHEMA minus the new column.
    old.exec(SCHEMA.replace('    tool_use_id TEXT,\n', '').replace('    is_error    INTEGER,\n', '').replace('    first_token_ms     INTEGER,\n    request_ms         INTEGER,\n    context            TEXT,\n', ''));
    old.exec("INSERT INTO tool_calls (id, prompt_id, call_order, call_type, name, timestamp) VALUES ('old1', 'p', 0, 'tool', 'Read', 1)");
    old.close();

    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { getDb, setToolCallOutput } = await import('./daemon/db/store.js');
      const db = getDb(); getDb();
      db.prepare("UPDATE tool_calls SET tool_use_id = 'tu1' WHERE id = 'old1'").run();
      setToolCallOutput('tu1', 'ok');
      const cols = db.prepare('PRAGMA table_info(prompts)').all().map(c => c.name).filter(n => ['first_token_ms', 'request_ms', 'context'].includes(n));
      const tcols = db.prepare('PRAGMA table_info(tool_calls)').all().map(c => c.name).filter(n => n === 'is_error');
      console.log(JSON.stringify({ rows: db.prepare('SELECT id, tool_use_id, output FROM tool_calls').all(), cols: [...cols, ...tcols] }));
    `], { cwd: REPO, env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), { rows: [{ id: 'old1', tool_use_id: 'tu1', output: 'ok' }], cols: ['first_token_ms', 'request_ms', 'context', 'is_error'] });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
