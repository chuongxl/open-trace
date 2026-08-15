/**
 * daemon/proxy/claude-proxy.js
 *
 * Transparent HTTP proxy on config.claudeProxyPort (default 9876).
 * Claude Code reads ANTHROPIC_BASE_URL and routes all traffic here.
 * This proxy forwards every request unchanged to api.anthropic.com,
 * intercepts the response, parses token usage + tool calls, writes to DB,
 * and returns the original response to Claude Code with zero modification.
 *
 * Handles both non-streaming and SSE streaming (stream:true) paths.
 * Issues: #3 (non-streaming), #4 (SSE), #5 (session correlation)
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import { basename } from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { upsertSession, insertPrompt, insertToolCall } from '../db/store.js';
import { estimateCost } from '../pricing/models.js';

// ─── Constants ───────────────────────────────────────────────────────────────
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_RAW_BYTES      = 32_000;          // cap stored request/response JSON
const MAX_TOOL_BYTES     = 4_000;           // cap stored tool input/output
const ANTHROPIC_HOST     = 'api.anthropic.com';

// ─── Session correlation (issue #5) ──────────────────────────────────────────
/**
 * In-memory rolling session map.
 * Key = normalized CWD path (or 'unknown').
 * Value = { sessionId, lastSeen, projectName }
 * Sessions expire after SESSION_TIMEOUT_MS of inactivity.
 */
const sessionMap = new Map();

/**
 * Extract the raw system prompt text from a request body.
 * Claude Code sends system as either a plain string or an array of content blocks.
 */
function extractSystemText(reqBody) {
  if (!reqBody.system) return '';
  if (typeof reqBody.system === 'string') return reqBody.system;
  if (Array.isArray(reqBody.system)) {
    return reqBody.system
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join(' ');
  }
  return '';
}

/**
 * Extract the CWD from Claude Code's injected system prompt.
 * Claude Code injects lines like: 'cwd: /Users/alex/dev/myproject'
 */
function extractCwd(systemText) {
  const m = systemText.match(/cwd[:\s]+([^\n\r,"]+)/i);
  return m ? m[1].trim() : null;
}

/**
 * Derive (or reuse) a session ID for this request.
 * Groups prompts into sessions based on CWD + 30-min inactivity window.
 */
function deriveSessionId(reqBody) {
  const systemText = extractSystemText(reqBody);
  const cwd        = extractCwd(systemText);
  const key        = cwd || 'unknown';
  const now        = Date.now();

  const existing = sessionMap.get(key);
  if (existing && (now - existing.lastSeen) < SESSION_TIMEOUT_MS) {
    existing.lastSeen = now;
    return existing.sessionId;
  }

  // New session
  const sessionId = randomUUID();
  const projectName = cwd ? basename(cwd) : 'unknown';
  sessionMap.set(key, { sessionId, lastSeen: now, projectName, projectPath: cwd });
  return sessionId;
}

/** Get the project info for a given session key */
function getProjectInfo(reqBody) {
  const systemText  = extractSystemText(reqBody);
  const cwd         = extractCwd(systemText);
  const key         = cwd || 'unknown';
  const entry       = sessionMap.get(key);
  return {
    projectPath: entry?.projectPath ?? cwd ?? null,
    projectName: entry?.projectName ?? (cwd ? basename(cwd) : null),
  };
}

/**
 * Extract the last user-role message text for storage.
 */
function extractUserText(messages) {
  if (!Array.isArray(messages)) return null;
  const last = [...messages].reverse().find(m => m.role === 'user');
  if (!last) return null;
  if (typeof last.content === 'string') return last.content.slice(0, 2000);
  if (Array.isArray(last.content)) {
    return last.content
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join(' ')
      .slice(0, 2000);
  }
  return null;
}

/** Safely truncate a JSON string for storage */
function capJson(obj, maxBytes) {
  try {
    const s = JSON.stringify(obj);
    return s.length > maxBytes ? s.slice(0, maxBytes) + '…' : s;
  } catch { return null; }
}