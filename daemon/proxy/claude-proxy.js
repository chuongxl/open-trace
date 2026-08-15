/**
 * daemon/proxy/claude-proxy.js
 *
 * Transparent HTTP proxy on config.claudeProxyPort (default 9876).
 * Claude Code reads ANTHROPIC_BASE_URL and routes all traffic here.
 * Forwards every request unchanged to api.anthropic.com, intercepts the
 * response, parses token usage + tool calls, writes to DB, and returns the
 * original response to Claude Code with zero modification.
 *
 * Two code paths:
 *   - Non-streaming (stream:false or absent): buffer full response, then parse.
 *   - SSE streaming (stream:true): tee chunks to client immediately AND buffer
 *     for parsing after message_stop event. Zero latency penalty.
 *
 * Issues: #3 (non-streaming), #4 (SSE streaming), #5 (session correlation)
 */

import http from 'http';
import https from 'https';
import { basename } from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { upsertSession, insertPrompt, insertToolCall } from '../db/store.js';
import { estimateCost } from '../pricing/models.js';

// ─── Constants ───────────────────────────────────────────────────────────────
const SESSION_TIMEOUT_MS  = 30 * 60 * 1000; // 30-min inactivity window
const SESSION_PRUNE_MS    = 60 * 60 * 1000; // prune stale entries hourly
const MAX_RAW_BYTES       = 32_000;          // cap stored request/response
const MAX_TOOL_BYTES      = 4_000;           // cap stored tool input/output
const ANTHROPIC_HOST      = 'api.anthropic.com';

// ─── Session correlation (issue #5) ──────────────────────────────────────────

/**
 * In-memory rolling session map.
 * Key   = normalized CWD string (or 'unknown').
 * Value = { sessionId, lastSeen, projectPath, projectName }
 */
const sessionMap = new Map();

// Prune sessions idle longer than SESSION_TIMEOUT_MS, run hourly.
setInterval(() => {
  const cutoff = Date.now() - SESSION_TIMEOUT_MS;
  for (const [key, entry] of sessionMap) {
    if (entry.lastSeen < cutoff) sessionMap.delete(key);
  }
}, SESSION_PRUNE_MS).unref(); // .unref() so the interval doesn't block process exit

/**
 * Extract raw system prompt text from a request body.
 * Claude Code sends system as a plain string or an array of content blocks.
 */
function extractSystemText(reqBody) {
  if (!reqBody.system) return '';
  if (typeof reqBody.system === 'string') return reqBody.system;
  if (Array.isArray(reqBody.system))
    return reqBody.system.filter(b => b.type === 'text').map(b => b.text || '').join(' ');
  return '';
}

/**
 * Extract the working directory from Claude Code's injected system prompt.
 * Claude Code always injects a line like: 'cwd: /Users/alex/dev/myproject'
 */
function extractCwd(systemText) {
  const m = systemText.match(/cwd[:\s]+([^\n\r,"]+)/i);
  return m ? m[1].trim() : null;
}

/**
 * Derive or reuse a session ID for this request.
 * Groups successive prompts from the same working directory into one session.
 * A gap of more than SESSION_TIMEOUT_MS starts a fresh session.
 */
function deriveSessionId(reqBody) {
  const cwd = extractCwd(extractSystemText(reqBody));
  const key = cwd || 'unknown';
  const now = Date.now();
  const ex  = sessionMap.get(key);
  if (ex && (now - ex.lastSeen) < SESSION_TIMEOUT_MS) {
    ex.lastSeen = now;
    return ex.sessionId;
  }
  const sessionId = randomUUID();
  sessionMap.set(key, {
    sessionId, lastSeen: now,
    projectPath: cwd,
    projectName: cwd ? basename(cwd) : 'unknown',
  });
  return sessionId;
}

/** Return project path and name for the current session key. */
function getProjectInfo(reqBody) {
  const cwd   = extractCwd(extractSystemText(reqBody));
  const entry = sessionMap.get(cwd || 'unknown');
  return {
    projectPath: entry?.projectPath ?? cwd ?? null,
    projectName: entry?.projectName ?? (cwd ? basename(cwd) : null),
  };
}

/**
 * Extract the text of the last user-role message for storage.
 * Caps at 2000 chars to avoid bloating the DB.
 */
function extractUserText(messages) {
  if (!Array.isArray(messages)) return null;
  const last = [...messages].reverse().find(m => m.role === 'user');
  if (!last) return null;
  if (typeof last.content === 'string') return last.content.slice(0, 2000);
  if (Array.isArray(last.content))
    return last.content.filter(b => b.type === 'text').map(b => b.text || '').join(' ').slice(0, 2000);
  return null;
}

/**
 * Safely JSON-stringify and cap at maxBytes.
 * Returns null (with a logged warning) on serialization failure.
 */
function capJson(obj, maxBytes) {
  try {
    const s = JSON.stringify(obj);
    return s.length > maxBytes ? s.slice(0, maxBytes) + '\u2026' : s;
  } catch (err) {
    console.warn('[claude-proxy] capJson serialization failed:', err.message);
    return null;
  }
}

// ─── DB write ─────────────────────────────────────────────────────────────────

/**
 * Write session + prompt + tool_calls to SQLite after a completed response.
 * @param {object} reqBody   - Parsed request JSON from Claude Code
 * @param {object} usage     - Token counts: {input_tokens, output_tokens, cache_read_tokens, cache_write_tokens}
 * @param {string} model     - Model identifier string
 * @param {Array}  toolUses  - Array of {name, input} objects from tool_use blocks
 * @param {string} rawReq    - Capped raw request JSON for storage
 * @param {string} rawResp   - Capped raw response text for storage
 */
function writeToDb(reqBody, usage, model, toolUses, rawReq, rawResp) {
  try {
    const sessionId = deriveSessionId(reqBody);
    const { projectPath, projectName } = getProjectInfo(reqBody);
    const cost = estimateCost(model, usage);

    upsertSession({
      id:                  sessionId,
      tool:                'claude-code',
      started_at:          Date.now(),
      project_path:        projectPath,
      project_name:        projectName,
      model,
      total_input_tokens:  usage.input_tokens       || 0,
      total_output_tokens: usage.output_tokens      || 0,
      total_cache_read:    usage.cache_read_tokens  || 0,
      total_cache_write:   usage.cache_write_tokens || 0,
      equiv_cost_usd:      cost,
    });

    const promptId = randomUUID();
    insertPrompt({
      id:                 promptId,
      session_id:         sessionId,
      timestamp:          Date.now(),
      model,
      input_text:         extractUserText(reqBody.messages),
      input_tokens:       usage.input_tokens       || 0,
      output_tokens:      usage.output_tokens      || 0,
      cache_read_tokens:  usage.cache_read_tokens  || 0,
      cache_write_tokens: usage.cache_write_tokens || 0,
      equiv_cost_usd:     cost,
      raw_request:        rawReq,
      raw_response:       rawResp,
    });

    toolUses.forEach((tool, i) => {
      insertToolCall({
        id:         randomUUID(),
        prompt_id:  promptId,
        call_order: i,
        call_type:  'tool',
        name:       tool.name,
        input:      capJson(tool.input, MAX_TOOL_BYTES),
        output:     null,
        timestamp:  Date.now(),
      });
    });
  } catch (err) {
    console.error('[claude-proxy] DB write error:', err.message);
  }
}

// ─── Non-streaming path (issue #3) ────────────────────────────────────────────

/**
 * Parse a complete (non-streaming) Anthropic response and write to DB.
 * Extracts usage, model, and tool_use blocks from the response body.
 */
function parseNonStreaming(reqBody, rawRespStr) {
  let resp;
  try { resp = JSON.parse(rawRespStr); } catch (err) {
    console.warn('[claude-proxy] non-streaming JSON parse failed:', err.message);
    return;
  }
  if (!resp || resp.type === 'error') return;

  const u = resp.usage || {};
  const usage = {
    input_tokens:       u.input_tokens                  || 0,
    output_tokens:      u.output_tokens                 || 0,
    cache_read_tokens:  u.cache_read_input_tokens        || 0,
    cache_write_tokens: u.cache_creation_input_tokens    || 0,
  };
  const model    = reqBody.model || resp.model || 'unknown';
  const toolUses = (resp.content || []).filter(b => b.type === 'tool_use');
  const rawReq   = capJson(reqBody, MAX_RAW_BYTES);
  const rawResp  = rawRespStr.length > MAX_RAW_BYTES
    ? rawRespStr.slice(0, MAX_RAW_BYTES) + '\u2026' : rawRespStr;

  writeToDb(reqBody, usage, model, toolUses, rawReq, rawResp);
}

/**
 * Forward a non-streaming request to api.anthropic.com.
 * Buffers the full response, returns it to Claude Code, then parses and stores.
 */
function forwardNonStreaming(reqBody, rawBody, req, res) {
  const options = {
    hostname: ANTHROPIC_HOST,
    port: 443,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: ANTHROPIC_HOST },
  };

  const proxyReq = https.request(options, proxyRes => {
    const chunks = [];
    proxyRes.on('data', c => chunks.push(c));
    proxyRes.on('end', () => {
      const rawResp = Buffer.concat(chunks);
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      res.end(rawResp);
      if (proxyRes.statusCode === 200) {
        try { parseNonStreaming(reqBody, rawResp.toString('utf8')); }
        catch (err) { console.error('[claude-proxy] parse error:', err.message); }
      }
    });
    proxyRes.on('error', err => console.error('[claude-proxy] upstream response error:', err.message));
  });

  proxyReq.on('error', err => {
    console.error('[claude-proxy] upstream connection error:', err.message);
    if (!res.headersSent) { res.writeHead(502); res.end('Bad Gateway'); }
  });
  proxyReq.write(rawBody);
  proxyReq.end();
}

// ─── SSE streaming path (issue #4) ────────────────────────────────────────────

/**
 * Parse accumulated SSE text to reconstruct token usage and tool calls.
 * Handles: message_start, content_block_start (tool_use), content_block_delta,
 * message_delta, message_stop.
 * Malformed data: lines are individually try/caught; partial JSON is skipped.
 */
function parseStreamAndStore(reqBody, sseText) {
  const events = [];
  for (const line of sseText.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const raw = line.slice(6).trim();
    if (raw === '[DONE]') continue;
    try { events.push(JSON.parse(raw)); } catch { /* skip malformed SSE line */ }
  }

  let inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheWrite = 0;
  let model = reqBody.model || 'unknown';
  const toolMap = new Map(); // tool_use_id -> { name, inputChunks[] }
  let currentToolId = null;

  for (const ev of events) {
    switch (ev.type) {
      case 'message_start': {
        const u = ev.message?.usage || {};
        inputTokens = u.input_tokens                  || 0;
        cacheRead   = u.cache_read_input_tokens        || 0;
        cacheWrite  = u.cache_creation_input_tokens    || 0;
        model       = ev.message?.model || model;
        break;
      }
      case 'content_block_start': {
        // Track tool_use blocks; reset currentToolId for non-tool blocks
        if (ev.content_block?.type === 'tool_use') {
          currentToolId = ev.content_block.id;
          toolMap.set(currentToolId, { name: ev.content_block.name, inputChunks: [] });
        } else {
          currentToolId = null;
        }
        break;
      }
      case 'content_block_delta': {
        if (ev.delta?.type === 'input_json_delta' && currentToolId && toolMap.has(currentToolId)) {
          toolMap.get(currentToolId).inputChunks.push(ev.delta.partial_json || '');
        }
        break;
      }
      case 'message_delta': {
        outputTokens = ev.usage?.output_tokens || outputTokens;
        break;
      }
      // message_stop: no data to extract, just signals completion
    }
  }

  // Assemble tool_use objects with reconstructed input JSON
  const toolUses = [];
  for (const [, tool] of toolMap) {
    const joined = tool.inputChunks.join('');
    let input = null;
    if (joined) {
      try { input = JSON.parse(joined); } catch { input = joined; /* store as raw string */ }
    }
    toolUses.push({ name: tool.name, input });
  }

  const usage = {
    input_tokens: inputTokens, output_tokens: outputTokens,
    cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite,
  };
  const rawReq  = capJson(reqBody, MAX_RAW_BYTES);
  const rawResp = sseText.length > MAX_RAW_BYTES ? sseText.slice(0, MAX_RAW_BYTES) + '\u2026' : sseText;

  writeToDb(reqBody, usage, model, toolUses, rawReq, rawResp);
}

/**
 * Forward a streaming (SSE) request to api.anthropic.com.
 * Tees each chunk: forwards to client immediately AND buffers for parsing.
 * DB write happens after the stream ends (message_stop received).
 */
function forwardStreaming(reqBody, rawBody, req, res) {
  const options = {
    hostname: ANTHROPIC_HOST,
    port: 443,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: ANTHROPIC_HOST },
  };

  const proxyReq = https.request(options, proxyRes => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    const sseChunks = [];
    proxyRes.on('data', chunk => {
      res.write(chunk);           // Forward immediately — preserves streaming latency
      sseChunks.push(chunk);      // Buffer for post-stream parsing
    });
    proxyRes.on('end', () => {
      res.end();
      if (proxyRes.statusCode === 200) {
        const sseText = Buffer.concat(sseChunks).toString('utf8');
        try { parseStreamAndStore(reqBody, sseText); }
        catch (err) { console.error('[claude-proxy] SSE parse error:', err.message); }
      }
    });
    proxyRes.on('error', err => console.error('[claude-proxy] upstream stream error:', err.message));
  });

  proxyReq.on('error', err => {
    console.error('[claude-proxy] upstream stream connection error:', err.message);
    if (!res.headersSent) { res.writeHead(502); res.end('Bad Gateway'); }
  });
  proxyReq.write(rawBody);
  proxyReq.end();
}

// ─── Main request handler ─────────────────────────────────────────────────────

/**
 * Main HTTP request handler.
 * Routes /v1/messages POST calls through the intercept paths.
 * All other requests are piped through to Anthropic unchanged.
 */
function handleRequest(req, res) {
  const isMessages = req.method === 'POST' && req.url.includes('/messages');

  if (!isMessages) {
    // Pass-through: pipe directly to Anthropic (models, count_tokens, etc.)
    const fwd = https.request({
      hostname: ANTHROPIC_HOST, port: 443,
      path: req.url, method: req.method,
      headers: { ...req.headers, host: ANTHROPIC_HOST },
    }, pr => { res.writeHead(pr.statusCode, pr.headers); pr.pipe(res); });
    fwd.on('error', err => {
      console.error('[claude-proxy] pass-through error:', err.message);
      if (!res.headersSent) { res.writeHead(502); res.end(); }
    });
    req.pipe(fwd);
    return;
  }

  // Buffer the full request body before routing
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('error', err => {
    console.error('[claude-proxy] request read error:', err.message);
    if (!res.headersSent) { res.writeHead(500); res.end(); }
  });
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks);
    let reqBody = {};
    try { reqBody = JSON.parse(rawBody.toString('utf8')); }
    catch { /* non-JSON body: forward as-is via non-streaming path */ }

    if (reqBody.stream === true) {
      forwardStreaming(reqBody, rawBody, req, res);
    } else {
      forwardNonStreaming(reqBody, rawBody, req, res);
    }
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the Claude Code intercepting proxy server.
 * All requests from Claude Code with ANTHROPIC_BASE_URL set to this server
 * will be intercepted, stored, and forwarded to api.anthropic.com.
 *
 * @param {number} port - Port to listen on (typically config.claudeProxyPort = 9876)
 * @returns {http.Server}
 */
export function createClaudeProxy(port) {
  const server = http.createServer(handleRequest);

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error('[claude-proxy] Port ' + port + ' is already in use. Is another instance running?');
      process.exit(1);
    }
    console.error('[claude-proxy] Server error:', err.message);
  });

  server.listen(port, () => {
    const addr = 'http://' + 'localhost:' + port;
    console.log('[claude-proxy] Listening at ' + addr);
    console.log('[claude-proxy] Set ANTHROPIC_BASE_URL=' + addr + ' before running claude');
  });

  return server;
}