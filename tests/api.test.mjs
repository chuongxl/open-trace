// Hermetic integration test for the Phase 4 REST API layer.
// Boots the real daemon against a temp DB, seeds via the real store,
// then asserts every endpoint shape from issue #7.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');

let tmp, api, child, out = '';

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ot-api-'));
  const projA = join(tmp, 'proj-a');
  const projB = join(tmp, 'proj-b');
  mkdirSync(join(projA, '.claude'), { recursive: true });
  mkdirSync(projB, { recursive: true });
  writeFileSync(join(projA, '.claude', 'memory.md'), '# Project memory\nKey decisions here.');

  process.env.DB_PATH = join(tmp, 'open-trace.db');
  const store = await import('../daemon/db/store.js');
  const now = Date.now();
  store.upsertSession({ id: 'sess-a', tool: 'opencode', started_at: now - 86400000, ended_at: now - 86000000, project_path: projA, project_name: 'proj-a', model: 'claude-haiku-4-5', total_input_tokens: 1000, total_output_tokens: 500, total_cache_read: 100, total_cache_write: 50, equiv_cost_usd: 0.15 });
  store.upsertSession({ id: 'sess-b', tool: 'claude-code', started_at: now - 7200000, ended_at: now - 7100000, project_path: projB, project_name: 'proj-b', model: 'claude-sonnet-4-5', total_input_tokens: 200, total_output_tokens: 100, total_cache_read: 0, total_cache_write: 0, equiv_cost_usd: 0.05 });
  store.upsertSession({ id: 'sess-c', tool: 'opencode', started_at: now - 3600000, ended_at: null, project_path: null, project_name: 'no-dir', model: 'claude-haiku-4-5', total_input_tokens: 10, total_output_tokens: 5, total_cache_read: 0, total_cache_write: 0, equiv_cost_usd: 0.001 });
  store.insertPrompt({ id: 'p1', session_id: 'sess-a', timestamp: now - 86300000, model: 'claude-haiku-4-5', input_text: 'first prompt', input_tokens: 500, output_tokens: 250, cache_read_tokens: 100, cache_write_tokens: 50, equiv_cost_usd: 0.08 });
  store.insertPrompt({ id: 'p2', session_id: 'sess-a', timestamp: now - 86260000, model: 'claude-haiku-4-5', input_text: 'second prompt', input_tokens: 500, output_tokens: 250, cache_read_tokens: 0, cache_write_tokens: 0, equiv_cost_usd: 0.07 });
  store.insertToolCall({ id: 'tc1', prompt_id: 'p1', call_order: 0, call_type: 'tool', name: 'read_file', input: 'a.js', output: 'content', duration_ms: 120, timestamp: now - 86290000 });
  store.insertToolCall({ id: 'tc2', prompt_id: 'p1', call_order: 1, call_type: 'tool', name: 'search_files', input: 'TODO', output: '[]', duration_ms: 40, timestamp: now - 86280000 });
  store.insertOptimization({ id: 'opt1', prompt_id: 'p1', original_prompt: 'first prompt', optimized_prompt: 'optimized prompt text', improvement_notes: 'clearer', token_delta: -100, webllm_model: 'qwen2.5-7b', created_at: now });

  child = spawn(process.execPath, [join(REPO, 'daemon', 'index.js')], {
    cwd: REPO,
    env: { ...process.env, DB_PATH: join(tmp, 'open-trace.db'), OPENCODE_DB_PATH: join(tmp, 'missing-opencode.db'), DAEMON_PORT: '0', CLAUDE_PROXY_PORT: '0', COPILOT_PROXY_PORT: '0' },
  });
  child.stdout.on('data', d => { out += d.toString(); });
  child.stderr.on('data', d => { out += d.toString(); });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const m = out.match(/http:\/\/localhost:(\d+)/);
    if (m) { api = 'http://' + '127.0.0.1:' + m[1]; break; }
    await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(api, 'daemon failed to report a port in 20s: ' + out.slice(-1500));
});

after(() => { child?.kill('SIGTERM'); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

const getJson = async (path, exp = 200) => {
  const res = await fetch(api + path);
  assert.equal(res.status, exp, path + ' -> ' + res.status + ' ' + out.slice(-800));
  return res.json();
};

test('GET /api/health returns status and version', async () => {
  const h = await getJson('/api/health');
  assert.equal(h.status, 'ok');
  assert.ok(h.uptime >= 0);
  assert.equal(h.version, '0.1.0');
});

test('GET /api/overview aggregates tokens and cost per tool per day', async () => {
  const rows = await getJson('/api/overview?days=30');
  assert.ok(rows.length >= 2, 'expected rows for opencode and claude-code, got ' + rows.length);
  const oc = rows.find(r => r.tool === 'opencode');
  assert.ok(oc, 'opencode row missing: ' + JSON.stringify(rows));
  assert.equal(oc.input_tokens + oc.output_tokens, 1215, 'opencode totals');
  assert.ok(oc.equiv_cost > 0.15, 'opencode cost includes both sessions');
  const cc = rows.find(r => r.tool === 'claude-code');
  assert.equal(cc.session_count, 1);
});

test('GET /api/projects lists projects with session counts and totals', async () => {
  const rows = await getJson('/api/projects');
  assert.ok(rows.length >= 2, 'expected proj-a and proj-b, got ' + rows.length);
  const a = rows.find(r => r.project_path.endsWith('proj-a'));
  assert.ok(a, 'proj-a missing: ' + JSON.stringify(rows));
  assert.equal(a.session_count, 1);
  assert.equal(a.total_tokens, 1500);
  assert.equal(Number(a.total_equiv_cost), 0.15);
  assert.ok(a.last_active, 'last_active present');
});

test('GET /api/sessions paginates and filters by tool', async () => {
  const all = await getJson('/api/sessions');
  assert.equal(all.length, 3, 'all sessions, newest first');
  assert.equal(all[0].id, 'sess-c', 'newest first');
  const oc = await getJson('/api/sessions?tool=opencode');
  assert.equal(oc.length, 2);
  const page = await getJson('/api/sessions?limit=1&offset=1');
  assert.equal(page.length, 1);
  assert.equal(page[0].id, 'sess-b');
});

test('GET /api/sessions/:id returns session with ordered prompts', async () => {
  const s = await getJson('/api/sessions/sess-a');
  assert.equal(s.id, 'sess-a');
  assert.equal(s.prompts.length, 2);
  assert.equal(s.prompts[0].id, 'p1', 'prompts ordered by timestamp asc');
  assert.equal(s.prompts[1].id, 'p2');
});

test('GET /api/sessions/:id returns 404 for unknown session', async () => {
  await getJson('/api/sessions/nope', 404);
});

test('GET /api/sessions/:id/memory reads project memory file', async () => {
  const m = await getJson('/api/sessions/sess-a/memory');
  const proj = m.files.find(f => f.display.includes('project'));
  assert.ok(proj, 'project memory file present: ' + JSON.stringify(m.files));
  assert.ok(proj.content.includes('Key decisions'), 'memory content read');
  assert.ok(proj.size > 0);
  assert.ok(proj.modified_at > 0);
  const m2 = await getJson('/api/sessions/sess-b/memory');
  assert.ok(Array.isArray(m2.files), 'missing file degrades to empty array');
});

test('GET /api/prompts/:id returns prompt with tool calls in call_order', async () => {
  const p = await getJson('/api/prompts/p1');
  assert.equal(p.id, 'p1');
  assert.equal(p.tool_calls.length, 2);
  assert.equal(p.tool_calls[0].id, 'tc1', 'call_order 0 first');
  assert.equal(p.tool_calls[1].id, 'tc2', 'call_order 1 second');
  assert.equal(p.tool_calls[0].name, 'read_file');
});

test('GET /api/prompts/:id returns 404 for unknown prompt', async () => {
  await getJson('/api/prompts/nope', 404);
});

test('POST /api/optimizations saves and retrieves a WebLLM result', async () => {
  const res = await fetch(api + '/api/optimizations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'opt2', prompt_id: 'p2', original_prompt: 'raw', optimized_prompt: 'better', improvement_notes: 'shorter', token_delta: -50, webllm_model: 'qwen2.5-7b' }),
  });
  assert.equal(res.status, 200, await res.text());
  const got = await getJson('/api/optimizations/p2');
  assert.equal(got.id, 'opt2');
  assert.equal(got.optimized_prompt, 'better');
  const miss = await getJson('/api/optimizations/none');
  assert.equal(miss, null);
});
