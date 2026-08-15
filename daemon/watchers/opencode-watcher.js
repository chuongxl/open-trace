/**
 * daemon/watchers/opencode-watcher.js
 *
 * Watches OpenCode's local SQLite DB and syncs new sessions, prompts, and tool
 * calls into the open-trace DB in near-real-time. No proxy or MITM needed —
 * OpenCode writes everything to its SQLite DB; we read it as a readonly consumer.
 *
 * Sync strategy:
 *   - On startup: query MAX(timestamp) from our own prompts for opencode sessions
 *     to find the last-synced point. Only pull newer messages.
 *   - On each file-change event: reopen OpenCode DB readonly, sync new rows.
 *   - INSERT OR IGNORE on prompts/tool_calls prevents duplicates on edge cases.
 *   - Sessions use ACCUMULATE upsert, so calling upsertSession repeatedly is safe.
 *
 * Issue: #6
 */

import chokidar from 'chokidar';
import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { upsertSession, insertPrompt, insertToolCall, getDb } from '../db/store.js';
import { estimateCost } from '../pricing/models.js';

// Minimum ms between sync runs (debounce rapid WAL writes)
const DEBOUNCE_MS = 500;

let syncTimer   = null;
let isSyncing   = false;

// ── Cursor ────────────────────────────────────────────────────────────────────

/**
 * Return the timestamp of the most recently synced OpenCode message.
 * We store opencode prompts with session.tool='opencode'.
 * Returns 0 if nothing has been synced yet (full initial sync).
 */
function getLastSyncedAt() {
  try {
    const row = getDb().prepare(`
      SELECT MAX(p.timestamp) AS last_ts
      FROM prompts p
      JOIN sessions s ON s.id = p.session_id
      WHERE s.tool = 'opencode'
    `).get();
    return row?.last_ts ?? 0;
  } catch {
    return 0;
  }
}

// ── Token extraction ──────────────────────────────────────────────────────────

/**
 * Sum token counts across all parts that carry a tokens JSON object.
 * OpenCode parts.tokens = { input, output, cache_read, cache_write }
 * @param {Array} parts - array of opencode part rows
 * @returns {{ input_tokens, output_tokens, cache_read_tokens, cache_write_tokens }}
 */
function extractTokens(parts) {
  let inp = 0, out = 0, cR = 0, cW = 0;
  for (const part of parts) {
    if (!part.tokens) continue;
    let tok;
    try { tok = typeof part.tokens === 'string' ? JSON.parse(part.tokens) : part.tokens; }
    catch { continue; }
    inp += tok.input        || 0;
    out += tok.output       || 0;
    cR  += tok.cache_read   || 0;
    cW  += tok.cache_write  || 0;
  }
  return { input_tokens: inp, output_tokens: out, cache_read_tokens: cR, cache_write_tokens: cW };
}

/**
 * Extract text from 'text'-type parts of the preceding user message.
 * @param {Array} userParts - parts belonging to the user message before this assistant turn
 */
function extractUserText(userParts) {
  if (!Array.isArray(userParts)) return null;
  return userParts
    .filter(p => p.type === 'text' && p.text)
    .map(p => p.text)
    .join(' ')
    .slice(0, 2000) || null;
}


/**
 * Normalize an OpenCode timestamp to milliseconds.
 * OpenCode may store created as Unix seconds (10 digits) or milliseconds (13 digits).
 */
function toMs(ts) {
  if (!ts) return Date.now();
  // If timestamp < year 2001 in ms (< 1e12), it's in seconds — convert to ms
  return ts < 1_000_000_000_000 ? ts * 1000 : ts;
}

// ── Session + message processing ──────────────────────────────────────────────

/**
 * Process one OpenCode session: upsert session row and insert all new prompts.
 * @param {object}   ocSession  - row from opencode sessions table
 * @param {Array}    messages   - rows from opencode messages for this session
 * @param {Database} ocDb       - readonly opencode DB handle
 * @param {number}   sinceTs    - only process messages with created > sinceTs
 */
function processSession(ocSession, messages, ocDb, sinceTs) {
  const sessionId   = 'oc-' + ocSession.id;
  const projectName = ocSession.title || 'opencode-session';

  // Group messages into user/assistant pairs chronologically
  // assistant messages become prompts; their preceding user message provides input_text
  let pendingUserParts = [];

  for (const msg of messages) {
    // Load parts for this message
    const parts = ocDb.prepare(
      'SELECT * FROM parts WHERE message_id = ? ORDER BY rowid ASC'
    ).all(msg.id);

    if (msg.role === 'user') {
      // Accumulate user parts for the next assistant turn
      pendingUserParts = parts;
      continue;
    }

    // Assistant message — this becomes a prompt row
    if (msg.role !== 'assistant') continue;

    // Only process messages newer than our last sync point
    if (toMs(msg.created) <= sinceTs) {
      pendingUserParts = [];
      continue;
    }

    const usage   = extractTokens(parts);
    const cost    = estimateCost('unknown', usage); // OpenCode may use various models
    const msgTs   = toMs(msg.created); // OpenCode stores epoch ms

    // Upsert session (accumulates token totals per call)
    upsertSession({
      id:                  sessionId,
      tool:                'opencode',
      started_at:          toMs(ocSession.created) || msgTs,
      project_path:        null, // OpenCode doesn't expose CWD in DB
      project_name:        projectName,
      model:               null,
      total_input_tokens:  usage.input_tokens,
      total_output_tokens: usage.output_tokens,
      total_cache_read:    usage.cache_read_tokens,
      total_cache_write:   usage.cache_write_tokens,
      equiv_cost_usd:      cost,
    });

    const promptId = 'oc-' + msg.id;
    insertPrompt({
      id:                 promptId,
      session_id:         sessionId,
      timestamp:          msgTs,
      model:              null,
      input_text:         extractUserText(pendingUserParts),
      input_tokens:       usage.input_tokens,
      output_tokens:      usage.output_tokens,
      cache_read_tokens:  usage.cache_read_tokens,
      cache_write_tokens: usage.cache_write_tokens,
      equiv_cost_usd:     cost,
      raw_request:        null,
      raw_response:       null,
    });

    // Map tool-call parts to tool_calls rows
    // Pair each tool-call with its matching tool-result (by tool_call_id or rowid proximity)
    const toolResultMap = new Map();
    for (const p of parts) {
      if (p.type === 'tool-result' && p.tool_call_id) {
        toolResultMap.set(p.tool_call_id, p);
      }
    }

    const toolCallParts = parts.filter(p => p.type === 'tool-call');
    toolCallParts.forEach((part, i) => {
      let inputJson  = null;
      let outputJson = null;

      // Cap raw strings before JSON parsing to avoid processing huge payloads
      const rawIn  = part.input  ? String(part.input).slice(0, 4000)  : null;
      const rawOut = result?.output ? String(result.output).slice(0, 4000) : null;
      try { inputJson  = rawIn  ? JSON.stringify(JSON.parse(rawIn))  : null; } catch { inputJson  = rawIn;  }
      const result = part.tool_call_id ? toolResultMap.get(part.tool_call_id) : null;
      if (result) {
        const rawOut2 = result.output ? String(result.output).slice(0, 4000) : null;
        try { outputJson = rawOut2 ? JSON.stringify(JSON.parse(rawOut2)) : null; } catch { outputJson = rawOut2; }
      }

      insertToolCall({
        id:         'oc-' + (part.id || randomUUID()),
        prompt_id:  promptId,
        call_order: i,
        call_type:  'tool',
        name:       part.tool_name || 'unknown',
        input:      inputJson ? inputJson.slice(0, 4000) : null,
        output:     outputJson ? outputJson.slice(0, 4000) : null,
        timestamp:  msgTs,
      });
    });

    pendingUserParts = []; // reset after consuming
  }
}

// ── Main sync ─────────────────────────────────────────────────────────────────

/**
 * Open OpenCode DB readonly, query messages newer than cursor, sync to open-trace.
 */
function syncOpenCode() {
  if (isSyncing) return; // prevent overlapping syncs
  isSyncing = true;

  if (!existsSync(config.openCodeDbPath)) {
    isSyncing = false;
    return; // DB doesn't exist yet — will retry on next file event
  }

  let ocDb;
  try {
    ocDb = new Database(config.openCodeDbPath, { readonly: true, fileMustExist: true });

    const sinceTs = getLastSyncedAt();

    // Fetch all sessions that have messages newer than sinceTs
    const sessions = ocDb.prepare(`
      SELECT DISTINCT s.*
      FROM sessions s
      JOIN messages m ON m.session_id = s.id
      WHERE m.created > ? OR m.created > ?
      -- first param: sinceTs in ms (OpenCode stores ms), second: sinceTs in seconds (some versions store seconds)
      ORDER BY s.created ASC
    `).all(sinceTs, Math.floor(sinceTs / 1000));

    let totalPrompts = 0;

    for (const ocSession of sessions) {
      const messages = ocDb.prepare(`
        SELECT * FROM messages WHERE session_id = ? ORDER BY created ASC
      `).all(ocSession.id);

      const newMsgCount = messages.filter(m => m.role === 'assistant' && m.created > sinceTs).length;
      totalPrompts += newMsgCount;

      processSession(ocSession, messages, ocDb, sinceTs);
    }

    if (totalPrompts > 0) {
      console.log('[opencode-watcher] synced ' + totalPrompts + ' new prompt(s) from ' + sessions.length + ' session(s)');
    }
  } catch (err) {
    console.error('[opencode-watcher] sync error:', err.message);
  } finally {
    try { ocDb?.close(); } catch {}
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
    persistent:   true,
    ignoreInitial: false,  // false = emit "add" for existing files → triggers initial sync on startup
    usePolling:   false,
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
