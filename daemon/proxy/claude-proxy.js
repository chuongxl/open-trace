/**
 * daemon/proxy/claude-proxy.js
 *
 * Transparent HTTP proxy on config.claudeProxyPort (default 9876).
 * Claude Code reads ANTHROPIC_BASE_URL and routes all traffic here.
 * Forwards every request unchanged to api.anthropic.com, intercepts the
 * response, parses token usage + tool calls, writes to DB, and returns the
 * original response to Claude Code with zero modification.
 *
 * Handles both non-streaming and SSE streaming (stream:true) paths.
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
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_RAW_BYTES      = 32_000;
const MAX_TOOL_BYTES     = 4_000;
const ANTHROPIC_HOST     = 'api.anthropic.com';

// ─── Session correlation ──────────────────────────────────────────────────────
const sessionMap = new Map();

function extractSystemText(reqBody) {
  if (!reqBody.system) return '';
  if (typeof reqBody.system === 'string') return reqBody.system;
  if (Array.isArray(reqBody.system))
    return reqBody.system.filter(b => b.type === 'text').map(b => b.text || '').join(' ');
  return '';
}

function extractCwd(systemText) {
  const m = systemText.match(/cwd[:\s]+([^\n\r,"]+)/i);
  return m ? m[1].trim() : null;
}

/**
 * Derive or reuse a sessionId based on CWD + 30-min rolling window.
 * Returns sessionId string.
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

function getProjectInfo(reqBody) {
  const cwd   = extractCwd(extractSystemText(reqBody));
  const entry = sessionMap.get(cwd || 'unknown');
  return {
    projectPath: entry?.projectPath ?? cwd ?? null,
    projectName: entry?.projectName ?? (cwd ? basename(cwd) : null),
  };
}

function extractUserText(messages) {
  if (!Array.isArray(messages)) return null;
  const last = [...messages].reverse().find(m => m.role === 'user');
  if (!last) return null;
  if (typeof last.content === 'string') return last.content.slice(0, 2000);
  if (Array.isArray(last.content))
    return last.content.filter(b => b.type === 'text').map(b => b.text || '').join(' ').slice(0, 2000);
  return null;
}

function capJson(obj, maxBytes) {
  try { const s = JSON.stringify(obj); return s.length > maxBytes ? s.slice(0, maxBytes) + '…' : s; }
  catch { return null; }
}

// ─── DB write ─────────────────────────────────────────────────────────────────

/**
 * Write session + prompt + tool_calls to DB after a completed response.
 * @param {object} reqBody  - parsed request JSON
 * @param {object} usage    - {input_tokens, output_tokens, cache_read_tokens, cache_write_tokens}
 * @param {string} model    - model string
 * @param {Array}  toolUses - array of {name, input} tool_use blocks
 * @param {string} rawReq   - raw request JSON string (capped)
 * @param {string} rawResp  - raw response JSON string (capped)
 */
function writeToDb(reqBody, usage, model, toolUses, rawReq, rawResp) {
  try {
    const sessionId = deriveSessionId(reqBody);
    const { projectPath, projectName } = getProjectInfo(reqBody);
    const cost = estimateCost(model, usage);

    upsertSession({
      id:           sessionId,
      tool:         'claude-code',
      started_at:   Date.now(),
      project_path: projectPath,
      project_name: projectName,
      model,
      total_input_tokens:  usage.input_tokens  || 0,
      total_output_tokens: usage.output_tokens || 0,
      total_cache_read:    usage.cache_read_tokens  || 0,
      total_cache_write:   usage.cache_write_tokens || 0,
      equiv_cost_usd: cost,
    });

    const promptId = randomUUID();
    insertPrompt({
      id:                promptId,
      session_id:        sessionId,
      timestamp:         Date.now(),
      model,
      input_text:        extractUserText(reqBody.messages),
      input_tokens:      usage.input_tokens  || 0,
      output_tokens:     usage.output_tokens || 0,
      cache_read_tokens: usage.cache_read_tokens  || 0,
      cache_write_tokens:usage.cache_write_tokens || 0,
      equiv_cost_usd:    cost,
      raw_request:       rawReq,
      raw_response:      rawResp,
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

function parseNonStreaming(reqBody, rawRespStr) {
  let resp;
  try { resp = JSON.parse(rawRespStr); } catch { return; }
  if (!resp || resp.type === 'error') return;

  const u = resp.usage || {};
  const usage = {
    input_tokens:       u.input_tokens                   || 0,
    output_tokens:      u.output_tokens                  || 0,
    cache_read_tokens:  u.cache_read_input_tokens         || 0,
    cache_write_tokens: u.cache_creation_input_tokens     || 0,
  };
  const model    = reqBody.model || resp.model || 'unknown';
  const toolUses = (resp.content || []).filter(b => b.type === 'tool_use');
  const rawReq   = capJson(reqBody, MAX_RAW_BYTES);
  const rawResp  = rawRespStr.length > MAX_RAW_BYTES
    ? rawRespStr.slice(0, MAX_RAW_BYTES) + '…' : rawRespStr;

  writeToDb(reqBody, usage, model, toolUses, rawReq, rawResp);
}

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
      // Return original response to Claude Code unchanged
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      res.end(rawResp);
      // Parse and store asynchronously (non-blocking)
      if (proxyRes.statusCode === 200) {
        try { parseNonStreaming(reqBody, rawResp.toString('utf8')); }
        catch (err) { console.error('[claude-proxy] parse error:', err.message); }
      }
    });
  });

  proxyReq.on('error', err => {
    console.error('[claude-proxy] upstream error:', err.message);
    if (!res.headersSent) { res.writeHead(502); res.end('Bad Gateway'); }
  });
  proxyReq.write(rawBody);
  proxyReq.end();
}

// ─── SSE streaming path (issue #4) ────────────────────────────────────────────

/**
 * Parse accumulated SSE event lines to reconstruct usage + tool calls.
 * SSE format: each event is 'data: {json}\n\n'
 */
function parseStreamAndStore(reqBody, sseText) {
  const events = [];
  for (const line of sseText.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const raw = line.slice(6).trim();
    if (raw === '[DONE]') continue;
    try { events.push(JSON.parse(raw)); } catch { /* skip malformed */ }
  }

  let inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheWrite = 0;
  let model = reqBody.model || 'unknown';
  // Map of tool_use_id -> {name, inputChunks[]}
  const toolMap = new Map();
  let currentToolId = null;

  for (const ev of events) {
    switch (ev.type) {
      case 'message_start': {
        const u = ev.message?.usage || {};
        inputTokens  = u.input_tokens                || 0;
        cacheRead    = u.cache_read_input_tokens      || 0;
        cacheWrite   = u.cache_creation_input_tokens  || 0;
        model        = ev.message?.model || model;
        break;
      }
      case 'content_block_start': {
        if (ev.content_block?.type === 'tool_use') {
          currentToolId = ev.content_block.id;
          toolMap.set(currentToolId, {
            name:        ev.content_block.name,
            inputChunks: [],
          });
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
    }
  }

  // Reconstruct tool_use objects with assembled input JSON
  const toolUses = [];
  for (const [, tool] of toolMap) {
    let input = null;
    const joined = tool.inputChunks.join('');
    if (joined) {
      try { input = JSON.parse(joined); } catch { input = joined; }
    }
    toolUses.push({ name: tool.name, input });
  }

  const usage = { input_tokens: inputTokens, output_tokens: outputTokens, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite };
  const rawReq  = capJson(reqBody, MAX_RAW_BYTES);
  const rawResp = sseText.length > MAX_RAW_BYTES ? sseText.slice(0, MAX_RAW_BYTES) + '…' : sseText;

  writeToDb(reqBody, usage, model, toolUses, rawReq, rawResp);
}

function forwardStreaming(reqBody, rawBody, req, res) {
  const options = {
    hostname: ANTHROPIC_HOST,
    port: 443,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: ANTHROPIC_HOST },
  };

  const proxyReq = https.request(options, proxyRes => {
    // Forward response headers unchanged
    res.writeHead(proxyRes.statusCode, proxyRes.headers);

    const sseChunks = [];

    proxyRes.on('data', chunk => {
      res.write(chunk);            // Forward immediately — zero latency
      sseChunks.push(chunk);       // Also buffer for parsing
    });

    proxyRes.on('end', () => {
      res.end();
      if (proxyRes.statusCode === 200) {
        const sseText = Buffer.concat(sseChunks).toString('utf8');
        try { parseStreamAndStore(reqBody, sseText); }
        catch (err) { console.error('[claude-proxy] SSE parse error:', err.message); }
      }
    });
  });

  proxyReq.on('error', err => {
    console.error('[claude-proxy] upstream stream error:', err.message);
    if (!res.headersSent) { res.writeHead(502); res.end('Bad Gateway'); }
  });
  proxyReq.write(rawBody);
  proxyReq.end();
}

// ─── Main request handler ─────────────────────────────────────────────────────

function handleRequest(req, res) {
  // Only intercept Anthropic messages API calls
  const isMessages = req.url.includes('/messages');

  if (!isMessages || req.method !== 'POST') {
    // Pass-through for non-messages endpoints (e.g. /v1/models)
    const options = {
      hostname: ANTHROPIC_HOST, port: 443,
      path: req.url, method: req.method,
      headers: { ...req.headers, host: ANTHROPIC_HOST },
    };
    const fwd = https.request(options, pr => {
      res.writeHead(pr.statusCode, pr.headers);
      pr.pipe(res);
    });
    fwd.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(fwd);
    return;
  }

  // Buffer the request body
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('error', err => {
    console.error('[claude-proxy] request read error:', err.message);
    res.writeHead(500); res.end();
  });
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks);
    let reqBody = {};
    try { reqBody = JSON.parse(rawBody.toString('utf8')); } catch { /* non-JSON */ }

    const isStreaming = reqBody.stream === true;
    if (isStreaming) {
      forwardStreaming(reqBody, rawBody, req, res);
    } else {
      forwardNonStreaming(reqBody, rawBody, req, res);
    }
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the Claude Code intercepting proxy server.
 * @param {number} port - Port to listen on (config.claudeProxyPort)
 */
export function createClaudeProxy(port) {
  const server = http.createServer(handleRequest);

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error('[claude-proxy] Port ' + port + ' already in use. Is another open-trace instance running?');
      process.exit(1);
    }
    console.error('[claude-proxy] Server error:', err.message);
  });

  server.listen(port, () => {
    const addr = 'http://' + 'localhost:' + port;
    console.log('[claude-proxy] Listening at ' + addr);
    console.log('[claude-proxy] Set ANTHROPIC_BASE_URL=' + addr);
  });

  return server;
}