import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { config } from '../config.js';
import { SCHEMA } from './schema.js';

let db;

export function getDb() {
  if (!db) {
    const dir = dirname(config.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    db = new Database(config.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
  }
  return db;
}

// ─── Write methods ────────────────────────────────────────────────────────────

/**
 * Upsert a session row. Token totals are ACCUMULATED — each call adds the delta
 * for that request, not the lifetime total. This allows the proxy to call
 * upsertSession once per prompt without tracking cumulative state.
 */
export function upsertSession(session) {
  // __replaceTotals: watchers (OpenCode) pass LIFETIME totals for the session;
  // set instead of accumulate to avoid double-counting on re-sync.
  // Default (proxy): accumulate per-request deltas.
  const replace  = session.__replaceTotals === true;
  const params   = { ...session };
  delete params.__replaceTotals;
  const add = (col) => '      ' + col + ' = ' + (replace ? 'excluded.' + col : col + ' + excluded.' + col) + ',\n';
  getDb().prepare(
    'INSERT INTO sessions\n' +
    '  (id, tool, started_at, project_path, project_name, model,\n' +
    '   total_input_tokens, total_output_tokens, total_cache_read, total_cache_write, equiv_cost_usd)\n' +
    'VALUES\n' +
    '  (@id, @tool, @started_at, @project_path, @project_name, @model,\n' +
    '   @total_input_tokens, @total_output_tokens, @total_cache_read, @total_cache_write, @equiv_cost_usd)\n' +
    'ON CONFLICT(id) DO UPDATE SET\n' +
    '  ended_at            = COALESCE(excluded.ended_at, ended_at),\n' +
    '  model               = COALESCE(excluded.model, model),\n' +
    add('total_input_tokens') +
    add('total_output_tokens') +
    add('total_cache_read') +
    add('total_cache_write') +
    '  equiv_cost_usd      = ' + (replace ? 'excluded.equiv_cost_usd' : 'equiv_cost_usd + excluded.equiv_cost_usd') + ',\n' +
    '  project_path        = COALESCE(excluded.project_path, project_path),\n' +
    '  project_name        = COALESCE(excluded.project_name, project_name)\n' +
    '  ').run({
    total_input_tokens: 0, total_output_tokens: 0,
    total_cache_read: 0, total_cache_write: 0, equiv_cost_usd: 0,
    project_name: null, model: null, ...params,
  });
}
export function insertPrompt(prompt) {
  getDb().prepare(`
    INSERT OR IGNORE INTO prompts
      (id, session_id, timestamp, model, input_text,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       equiv_cost_usd, raw_request, raw_response)
    VALUES
      (@id, @session_id, @timestamp, @model, @input_text,
       @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens,
       @equiv_cost_usd, @raw_request, @raw_response)
  `).run({
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
    cache_write_tokens: 0, equiv_cost_usd: 0,
    raw_request: null, raw_response: null, model: null, input_text: null,
    ...prompt,
  });
}

export function insertToolCall(call) {
  getDb().prepare(`
    INSERT OR IGNORE INTO tool_calls
      (id, prompt_id, call_order, call_type, name, input, output, duration_ms, timestamp)
    VALUES
      (@id, @prompt_id, @call_order, @call_type, @name, @input, @output, @duration_ms, @timestamp)
  `).run({ duration_ms: null, input: null, output: null, ...call });
}

export function insertOptimization(opt) {
  getDb().prepare(`
    INSERT OR REPLACE INTO optimizations
      (id, prompt_id, original_prompt, optimized_prompt, improvement_notes, token_delta, webllm_model, created_at)
    VALUES
      (@id, @prompt_id, @original_prompt, @optimized_prompt, @improvement_notes, @token_delta, @webllm_model, @created_at)
  `).run({ token_delta: null, webllm_model: null, ...opt });
}

// ─── Read methods ─────────────────────────────────────────────────────────────

export function getProjects() {
  return getDb().prepare(`
    SELECT
      project_path,
      project_name,
      tool,
      COUNT(*)                                     AS session_count,
      SUM(total_input_tokens + total_output_tokens) AS total_tokens,
      SUM(total_input_tokens)                       AS input_tokens,
      SUM(total_output_tokens)                      AS output_tokens,
      SUM(total_cache_read)                         AS cache_read,
      SUM(total_cache_write)                        AS cache_write,
      SUM(equiv_cost_usd)                           AS total_equiv_cost,
      MAX(started_at)                               AS last_active
    FROM sessions
    WHERE project_path IS NOT NULL
    GROUP BY project_path, tool
    ORDER BY last_active DESC
  `).all();
}

export function getSessions({ tool, project, limit = 50, offset = 0 } = {}) {
  let where = 'WHERE 1=1';
  const params = {};
  if (tool)    { where += ' AND tool = @tool';            params.tool = tool; }
  if (project) { where += ' AND project_path = @project'; params.project = project; }
  params.limit = limit; params.offset = offset;
  return getDb().prepare(`
    SELECT * FROM sessions ${where} ORDER BY started_at DESC LIMIT @limit OFFSET @offset
  `).all(params);
}

export function getSession(id) {
  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id);
}

export function getPrompts(sessionId) {
  return getDb().prepare('SELECT * FROM prompts WHERE session_id = ? ORDER BY timestamp ASC').all(sessionId);
}

export function getPrompt(id) {
  return getDb().prepare('SELECT * FROM prompts WHERE id = ?').get(id);
}

export function getToolCalls(promptId) {
  return getDb().prepare('SELECT * FROM tool_calls WHERE prompt_id = ? ORDER BY call_order ASC').all(promptId);
}

export function getOptimization(promptId) {
  return getDb().prepare('SELECT * FROM optimizations WHERE prompt_id = ? ORDER BY created_at DESC LIMIT 1').get(promptId);
}

export function getOverviewStats(days = 30) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  return getDb().prepare(`
    SELECT
      tool,
      date(started_at / 1000, 'unixepoch') AS day,
      COUNT(*)              AS session_count,
      SUM(total_input_tokens)  AS input_tokens,
      SUM(total_output_tokens) AS output_tokens,
      SUM(total_cache_read)    AS cache_read,
      SUM(total_cache_write)   AS cache_write,
      SUM(equiv_cost_usd)      AS equiv_cost
    FROM sessions
    WHERE started_at >= ?
    GROUP BY tool, day
    ORDER BY day ASC, tool ASC
  `).all(since);
}
