/**
 * OpenCode SQLite Watcher.
 *
 * Watches OpenCode's local SQLite DB and syncs new sessions, prompts, and tool
 * calls into open-trace. OpenCode (current versions) uses a single SQLite DB at
 *   ~/.local/share/opencode/opencode.db
 * with a project-style schema:
 *   session  (id, project_id, workspace_id, parent_id, slug, directory, title,
 *             metadata, cost, tokens_input, tokens_output, tokens_reasoning,
 *             tokens_cache_read, tokens_cache_write, agent, model,
 *             time_created, time_updated, ...)
 *   message  (id, session_id, time_created, time_updated, data JSON)
 *   part     (id, message_id, session_id, time_created, time_updated, data JSON)
 *
 * - message.data is a JSON blob like { role: 'user'|'assistant'|'tool', ... }
 * - part.data is a tagged JSON blob: { type: 'text', text }
 *                                    { type: 'tool-call', id, name, input }
 *                                    { type: 'tool-result', id, name, result }
 *                                    { type: 'reasoning', text }
 * - Token/cost totals live on the session row (no per-message usage).
 *
 * Sync cursor strategy:
 *   - On startup: query MAX(timestamp) from our own prompts table for
 *     tool='opencode' sessions — no extra state file, self-contained.
 *   - Changed/new sessions are discovered via a join on message.time_created,
 *     so old sessions that receive new messages are re-scanned.
 *   - INSERT OR IGNORE on prompts/tool_calls prevents duplicates.
 *   - Sessions use ACCUMULATE upsert (safe to call repeatedly).
 *
 * The OpenCode DB is opened read-only — open-trace can never modify it.
 */

import chokidar from 'chokidar';
import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { basename } from 'path';
import { config } from '../config.js';
import { upsertSession, insertPrompt, insertToolCall, getDb } from '../db/store.js';
import { estimateCost } from '../pricing/models.js';

// Minimum ms between sync runs (debounce rapid WAL writes)
const DEBOUNCE_MS = 500;

// Cap for any single input/output payload captured (chars, before JSON parse)
const PAYLOAD_CAP = 4000;

let syncTimer = null;
let isSyncing = false;

/**
 * Last synced timestamp: MAX(timestamp) from our own prompts for opencode.
 * We store opencode prompts with session.tool='opencode'.
 * @returns {number} epoch ms cursor; 0 if never synced
 */
function getLastSyncedAt() {
  const row = getDb()
    .prepare(`
      SELECT MAX(p.timestamp) AS last_ts
      FROM prompts p
      JOIN sessions s ON s.id = p.session_id
      WHERE s.tool = 'opencode'
    `)
    .get();
  return row && row.last_ts ? Number(row.last_ts) : 0;
}

/** Normalize a possibly-seconds epoch to ms (defensive: detect ms vs s). */
function toMs(ts) {
  if (!ts) return Date.now();
  const n = Number(ts);
  return n > 1e12 ? n : n * 1000;
}

/** Safe JSON.parse of a capped string; returns string on failure. */
function parseCapped(raw, cap) {
  if (!raw) return null;
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (!s) return null;
  const capped = s.slice(0, cap || PAYLOAD_CAP);
  try {
    return JSON.stringify(JSON.parse(capped));
  } catch {
    return capped;
  }
}

/** Read message.data safely; returns object or null. */
function readMessageData(msg) {
  try {
    const d = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
    return d && typeof d === 'object' ? d : null;
  } catch {
    return null;
  }
}

/** Read part.data safely; returns object or null. */
function readPartData(part) {
  try {
    const d = typeof part.data === 'string' ? JSON.parse(part.data) : part.data;
    return d && typeof d === 'object' ? d : null;
  } catch {
    return null;
  }
}

/** Extract text content from an array of part rows (for user input_text). */
function extractText(parts) {
  const chunks = [];
  for (const part of parts) {
    const d = readPartData(part);
    if (d && d.type === 'text' && typeof d.text === 'string') chunks.push(d.text);
    if (d && d.type === 'reasoning' && typeof d.text === 'string') chunks.push(d.text);
  }
  return chunks.join('\n') || null;
}

/**
 * Process one OpenCode session: upsert session row, insert prompts + tool calls.
 *
 * @param {object}   ocSession  - row from opencode session table
 * @param {Array}    messages   - opencode message rows (with parts preloaded)
 * @param {Database} ocDb       - readonly opencode DB handle
 */
function processSession(ocSession, messages, ocDb) {
  const sessionId   = 'oc-' + ocSession.id;
  const projectName = ocSession.title
    || (ocSession.directory ? basename(String(ocSession.directory)) : null)
    || 'opencode-session';
  const model        = ocSession.model || null;

  // Session totals come straight off the session row (ms timestamps)
  const sTs    = toMs(ocSession.time_created);
  const inTok  = Number(ocSession.tokens_input  || 0);
  const outTok = Number(ocSession.tokens_output || 0);
  const reaTok = Number(ocSession.tokens_reasoning || 0);
  const cacRd  = Number(ocSession.tokens_cache_read  || 0);
  const cacWr  = Number(ocSession.tokens_cache_write || 0);

  const cost = ocSession.cost != null
    ? Number(ocSession.cost)
    : estimateCost(model, { input_tokens: inTok, output_tokens: outTok + reaTok });

  upsertSession({
    id:                  sessionId,
    tool:                'opencode',
    __replaceTotals:     true,
    started_at:          sTs,
    project_path:        ocSession.directory || null,
    project_name:        projectName,
    model:               model,
    total_input_tokens:  inTok,
    total_output_tokens: outTok + reaTok,
    total_cache_read:    cacRd,
    total_cache_write:   cacWr,
    equiv_cost_usd:      cost,
  });

  // Map for pairing tool-result parts to their tool-call (same id in data)
  const toolCallIndex = new Map(); // part.data.id -> { promptId, name, order }

  let pendingUserParts = [];

  for (const msg of messages) {
    const data = readMessageData(msg);
    const role = data && data.role ? String(data.role) : null;

    const parts = ocDb.prepare(
      'SELECT * FROM part WHERE message_id = ? ORDER BY time_created ASC'
    ).all(msg.id);

    if (role === 'user') {
      pendingUserParts = parts;
      continue;
    }

    if (role !== 'assistant') continue; // skip 'tool' messages here (handled via results)

    const msgTs = toMs(msg.time_created);
    const promptId = 'oc-' + msg.id;

    // Per-message usage is not recorded by OpenCode; totals live on session.
    insertPrompt({
      id:                 promptId,
      session_id:         sessionId,
      timestamp:          msgTs,
      model:              model,
      input_text:         extractText(pendingUserParts),
      input_tokens:       null,
      output_tokens:      null,
      cache_read_tokens:  null,
      cache_write_tokens: null,
      equiv_cost_usd:     null,
      raw_request:        null,
      raw_response:       null,
    });

    // Tool-call parts on this assistant message
    let order = 0;
    for (const part of parts) {
      const d = readPartData(part);
      if (!d) continue;
      if (d.type === 'tool-call') {
        const inputJson = parseCapped(d.input, PAYLOAD_CAP);
        insertToolCall({
          id:         'oc-' + (part.id || randomUUID()),
          prompt_id:  promptId,
          call_order: order,
          call_type:  'tool-call',
          name:       d.name || 'unknown',
          input:      inputJson,
          output:     null,
          timestamp:  msgTs,
        });
        if (d.id) toolCallIndex.set(String(d.id), { promptId, name: d.name || 'unknown', order });
        order += 1;
      }
    }

    pendingUserParts = []; // consumed by this assistant turn
  }

  // Second pass: tool-result parts (role='tool' messages) pair via data.id
  for (const msg of messages) {
    const data = readMessageData(msg);
    if (!data || data.role !== 'tool') continue;

    const parts = ocDb.prepare(
      'SELECT * FROM part WHERE message_id = ? ORDER BY time_created ASC'
    ).all(msg.id);

    for (const part of parts) {
      const d = readPartData(part);
      if (!d || d.type !== 'tool-result') continue;
      const call = toolCallIndex.get(String(d.id));
      if (!call) continue; // result without a captured call in this window

      const outVal = d.result && d.result.value !== undefined ? d.result.value : null;
      const outputJson = parseCapped(outVal, PAYLOAD_CAP);
      insertToolCall({
        id:         'oc-' + (part.id || randomUUID()),
        prompt_id:  call.promptId,
        call_order: call.order,
        call_type:  'tool-result',
        name:       d.name || call.name,
        input:      null,
        output:     outputJson,
        timestamp:  toMs(msg.time_created),
      });
    }
  }
}

// ── Main sync ─────────────────────────────────────────────────────────────────

/**
 * Open OpenCode DB readonly, find sessions changed since cursor, sync them.
 */
function syncOpenCode() {
  if (isSyncing) return;
  isSyncing = true;

  const dbPath = config.openCodeDbPath;
  if (!dbPath || !existsSync(dbPath)) {
    console.log('[opencode-watcher] OpenCode DB not found at ' + (dbPath || '(unset)'));
    isSyncing = false;
    return;
  }

  let ocDb = null;
  try {
    ocDb = new Database(dbPath, { readonly: true, fileMustExist: true });

    const sinceTs = getLastSyncedAt();

    // Sessions that have at least one message newer than the cursor
    const sessions = ocDb.prepare(`
      SELECT DISTINCT s.*
      FROM session s
      JOIN message m ON m.session_id = s.id
      WHERE m.time_created > ?
      ORDER BY s.time_created ASC
    `).all(sinceTs);

    let totalPrompts = 0;
    for (const ocSession of sessions) {
      const messages = ocDb.prepare(
        'SELECT * FROM message WHERE session_id = ? ORDER BY time_created ASC'
      ).all(ocSession.id);
      if (!messages.length) continue;

      const before = getDb().prepare(
        'SELECT COUNT(*) AS c FROM prompts WHERE session_id = ?'
      ).get('oc-' + ocSession.id).c;

      processSession(ocSession, messages, ocDb);

      const after = getDb().prepare(
        'SELECT COUNT(*) AS c FROM prompts WHERE session_id = ?'
      ).get('oc-' + ocSession.id).c;
      totalPrompts += (after - before);
    }

    console.log(
      '[opencode-watcher] synced ' + totalPrompts + ' new prompt(s) from ' + sessions.length + ' session(s)'
    );
  } catch (err) {
    console.error('[opencode-watcher] sync error:', err.message);
  } finally {
    if (ocDb) ocDb.close();
    isSyncing = false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start watching the OpenCode SQLite DB for changes.
 * Gracefully handles cases where OpenCode is not installed.
 *
 * @returns {import('chokidar').FSWatcher|null}
 */
export function startOpenCodeWatcher() {
  const dbPath  = config.openCodeDbPath;
  const walPath = dbPath + '-wal';

  if (!existsSync(dbPath)) {
    console.log('[opencode-watcher] DB not found at ' + dbPath + ' — will watch for it');
  }

  // Watch both the DB and WAL file; WAL is written on every OpenCode commit
  const watcher = chokidar.watch([dbPath, walPath], {
    persistent:    true,
    ignoreInitial: false,  // false = emit 'add' for existing files → initial sync on startup
    usePolling:    false,
  });

  const scheduleSync = () => {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncOpenCode, DEBOUNCE_MS);
  };

  watcher.on('add',    scheduleSync);
  watcher.on('change', scheduleSync);
  watcher.on('error',  err => console.error('[opencode-watcher] watch error:', err.message));

  console.log('[opencode-watcher] watching ' + dbPath);
  return watcher;
}
