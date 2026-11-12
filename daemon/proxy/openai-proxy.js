/**
 * daemon/proxy/openai-proxy.js  (#28)
 *
 * OpenAI-compatible path of the proxy, for Aider, Continue.dev, Cline and Roo Code. The client's base URL
 * points at the same port as Claude Code (http://localhost:9876/v1); requests for /chat/completions are
 * forwarded to config.openaiUpstream and their usage, tool calls and tool results are stored in the same
 * tables as Claude Code sessions. Observe only: the debugger and overlay hooks do not apply here.
 *
 * These clients send no working directory, so the project is found from, in order:
 *   1. a `/_cwd/<base64url path>` prefix on the base URL (see README),
 *   2. markers in the prompt ("Current Working Directory (/x)" from Cline/Roo, "Primary working directory: /x"),
 *   3. none: the session is keyed by a hash of the conversation's first messages.
 */
import http from 'http';
import https from 'https';
import { randomUUID, createHash } from 'crypto';
import { basename } from 'path';
import { config } from '../config.js';
import { upsertSession, insertPrompt, insertToolCall, setToolCallOutput } from '../db/store.js';
import { estimateCost } from '../pricing/models.js';
import { analyzeContext } from '../context.js';
import { emit } from '../events.js';

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_RAW_BYTES = 32_000;
const MAX_TOOL_BYTES = 4_000;
const CWD_PREFIX = /^\/_cwd\/([A-Za-z0-9_-]+)/;
const OPENAI_PATH = /\/(chat\/completions|completions|embeddings|responses)$/;

// ─── Upstream ────────────────────────────────────────────────────────────────

function parseUpstream(url, injectOverride) {
  const u = new URL(url);
  return {
    tls: u.protocol === 'https:',
    hostname: u.hostname,
    port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
    basePath: u.pathname.replace(/\/$/, ''),
    injectUsage: injectOverride === undefined ? u.hostname === 'api.openai.com' : injectOverride === '1',
  };
}

let upstream = parseUpstream(config.openaiUpstream, config.openaiInjectUsage);
/** For tests: {hostname, port, tls, basePath?, injectUsage?} */
export function setOpenAIUpstream(u) { upstream = { basePath: '', injectUsage: false, ...u }; }

// ─── Routing ─────────────────────────────────────────────────────────────────

const pathOf = (req) => req.url.split('?')[0];

/** OpenAI-shaped endpoints go here; everything else keeps the Anthropic behaviour. */
export function isOpenAIRequest(req) {
  if (req.method !== 'POST' || req.headers['anthropic-version']) return false;
  return OPENAI_PATH.test(pathOf(req).replace(CWD_PREFIX, ''));
}

// ─── Shape helpers ───────────────────────────────────────────────────────────

const textOf = (content) =>
  typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((p) => (typeof p === 'string' ? p : p?.type === 'text' || p?.text ? p.text ?? '' : `[${p?.type ?? 'part'}]`)).join('\n')
    : '';

const messagesOf = (body) => (Array.isArray(body?.messages) ? body.messages : []);
const systemText = (body) => messagesOf(body).filter((m) => m.role === 'system' || m.role === 'developer').map((m) => textOf(m.content)).join('\n');

/** The user's prompt; null for a tool-loop continuation (the last message answers a tool call). */
export function extractUserText(messages) {
  const last = messages[messages.length - 1];
  if (!last || last.role === 'tool') return null;
  const user = [...messages].reverse().find((m) => m.role === 'user');
  return user ? textOf(user.content).slice(0, 2000) : null;
}

const CWD_MARKERS = [
  /Current (?:Working|Workspace) Directory \(([^)\n]+)\)/,
  /Primary working directory:[ \t]*([^\n\r]+)/i,
  /\bcwd:[ \t]*([^\s,"]+)/i,
];

function detectCwd(body) {
  const msgs = messagesOf(body);
  const scan = [...msgs.filter((m) => m.role === 'system' || m.role === 'developer'), ...msgs.slice(0, 3), msgs[msgs.length - 1]].filter(Boolean);
  for (const m of scan) {
    const text = textOf(m.content);
    for (const re of CWD_MARKERS) {
      const hit = text.match(re);
      if (hit) return hit[1].trim();
    }
  }
  return null;
}

export function detectClient(userAgent = '', body) {
  const ua = String(userAgent);
  if (/aider/i.test(ua)) return 'aider';
  if (/continue/i.test(ua)) return 'continue';
  if (/\bcline\b/i.test(ua)) return 'cline';
  if (/\broo/i.test(ua)) return 'roo-code';
  const sys = systemText(body);
  if (/You are Cline/i.test(sys)) return 'cline';
  if (/You are Roo/i.test(sys)) return 'roo-code';
  if (/Act as an expert software developer/i.test(sys)) return 'aider';
  return 'openai-compat';
}

/** OpenAI chat messages as Anthropic-style blocks, so the context analysis (daemon/context.js) can be reused. */
function toAnthropicShape(body) {
  const messages = [];
  for (const m of messagesOf(body)) {
    if (m.role === 'system' || m.role === 'developer') continue;
    if (m.role === 'tool') {
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: textOf(m.content) }] });
    } else if (m.role === 'assistant') {
      const blocks = [];
      if (textOf(m.content)) blocks.push({ type: 'text', text: textOf(m.content) });
      for (const tc of m.tool_calls ?? []) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = { arguments: tc.function?.arguments }; }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
      }
      messages.push({ role: 'assistant', content: blocks.length ? blocks : '' });
    } else {
      messages.push({ role: 'user', content: textOf(m.content) });
    }
  }
  return { system: systemText(body), tools: body.tools ?? [], messages };
}

// ─── Sessions ────────────────────────────────────────────────────────────────

const sessionMap = new Map();
setInterval(() => {
  const cutoff = Date.now() - SESSION_TIMEOUT_MS;
  for (const [k, v] of sessionMap) if (v.lastSeen < cutoff) sessionMap.delete(k);
}, 60 * 60 * 1000).unref();

function resolveSession(reqBody, meta) {
  const cwd = meta.cwd ?? detectCwd(reqBody);
  const tool = meta.client ?? detectClient('', reqBody);
  const first = messagesOf(reqBody).find((m) => m.role === 'user');
  const key = cwd ? `cwd:${cwd}` : 'conv:' + createHash('sha1').update(systemText(reqBody) + '\u0000' + textOf(first?.content)).digest('hex').slice(0, 16);
  const now = Date.now();
  const hit = sessionMap.get(key);
  if (hit && now - hit.lastSeen < SESSION_TIMEOUT_MS) { hit.lastSeen = now; return hit; }
  const entry = { sessionId: randomUUID(), lastSeen: now, tool, projectPath: cwd, projectName: cwd ? basename(cwd) : tool };
  sessionMap.set(key, entry);
  return entry;
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

function usageOf(u = {}) {
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input_tokens: Math.max(0, (u.prompt_tokens ?? 0) - cached),
    output_tokens: u.completion_tokens ?? 0,
    cache_read_tokens: cached,
    cache_write_tokens: 0,
  };
}

/** @returns {{model, usage, toolCalls: {id, name, args}[]}} from a non-streaming response body. */
export function readCompletion(respText) {
  const r = JSON.parse(respText);
  const calls = (r.choices?.[0]?.message?.tool_calls ?? []).map((tc) => ({ id: tc.id, name: tc.function?.name ?? 'unknown', args: tc.function?.arguments ?? '' }));
  return { model: r.model, usage: usageOf(r.usage), toolCalls: calls };
}

/** Same, from accumulated SSE text. Tool-call fragments are joined by index. */
export function readStream(sseText) {
  let model = null, usage = {};
  const calls = new Map();
  for (const line of sseText.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    let chunk; try { chunk = JSON.parse(raw); } catch { continue; }
    model = chunk.model ?? model;
    if (chunk.usage) usage = chunk.usage;
    for (const tc of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
      const c = calls.get(tc.index ?? 0) ?? { id: null, name: null, args: '' };
      c.id = tc.id ?? c.id;
      c.name = tc.function?.name ?? c.name;
      c.args += tc.function?.arguments ?? '';
      calls.set(tc.index ?? 0, c);
    }
  }
  return { model, usage: usageOf(usage), toolCalls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => ({ ...c, name: c.name ?? 'unknown' })) };
}

const cap = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s);

/** Results of the previous turn's tool calls arrive as role:"tool" messages after the last assistant message. */
function captureToolResults(messages, arrivedAt) {
  for (let i = messages.length - 1; i >= 0 && messages[i].role !== 'assistant'; i--) {
    const m = messages[i];
    if (m.role === 'tool' && m.tool_call_id) setToolCallOutput(m.tool_call_id, cap(textOf(m.content), MAX_TOOL_BYTES), arrivedAt);
  }
}

function store(reqBody, parsed, rawResp, timing, meta) {
  const { sessionId, projectPath, projectName, tool } = resolveSession(reqBody, meta);
  const model = reqBody.model || parsed.model || 'unknown';
  const usage = parsed.usage;
  const cost = estimateCost(model, usage);
  const endedAt = timing.endedAt ?? Date.now();
  const startedAt = timing.startedAt ?? endedAt;
  captureToolResults(messagesOf(reqBody), timing.startedAt);

  upsertSession({
    id: sessionId, tool, started_at: Date.now(), project_path: projectPath, project_name: projectName, model,
    total_input_tokens: usage.input_tokens, total_output_tokens: usage.output_tokens,
    total_cache_read: usage.cache_read_tokens, total_cache_write: usage.cache_write_tokens, equiv_cost_usd: cost,
  });

  const promptId = randomUUID();
  insertPrompt({
    id: promptId, session_id: sessionId, timestamp: startedAt, model,
    input_text: extractUserText(messagesOf(reqBody)),
    ...usage, equiv_cost_usd: cost,
    first_token_ms: timing.startedAt != null && timing.firstTokenAt != null ? timing.firstTokenAt - timing.startedAt : null,
    request_ms: timing.startedAt != null ? endedAt - timing.startedAt : null,
    context: JSON.stringify(analyzeContext(toAnthropicShape(reqBody))),
    raw_request: cap(JSON.stringify(reqBody), MAX_RAW_BYTES),
    raw_response: cap(rawResp, MAX_RAW_BYTES),
  });

  parsed.toolCalls.forEach((tc, i) => insertToolCall({
    id: randomUUID(), prompt_id: promptId, call_order: i, tool_use_id: tc.id ?? null, call_type: 'tool',
    name: tc.name, input: cap(tc.args, MAX_TOOL_BYTES), output: null, timestamp: endedAt,
  }));

  emit('turn_finished', {
    session_id: sessionId, prompt_id: promptId, model, ended_at: endedAt,
    input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
    cache_read_tokens: usage.cache_read_tokens, cache_write_tokens: 0,
    equiv_cost_usd: cost, tools: parsed.toolCalls.map((t) => t.name),
  });
  console.log(`[openai-proxy] stored: client=${tool} model=${model} in=${usage.input_tokens} out=${usage.output_tokens} tools=${parsed.toolCalls.length} sid=${sessionId.slice(0, 8)}`);
}

/** Exported for tests; the handler calls these after the response is complete. */
export function parseChatCompletion(reqBody, respText, timing = {}, meta = {}) {
  try { store(reqBody, readCompletion(respText), respText, timing, meta); }
  catch (err) { console.error('[openai-proxy] could not store response:', err.message); }
}
export function parseChatStream(reqBody, sseText, timing = {}, meta = {}) {
  try { store(reqBody, readStream(sseText), sseText, timing, meta); }
  catch (err) { console.error('[openai-proxy] could not store stream:', err.message); }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export function handleOpenAI(req, res) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('error', (err) => { console.error('[openai-proxy] request read error:', err.message); if (!res.headersSent) { res.writeHead(500); res.end(); } });
  req.on('end', () => {
    let rawBody = Buffer.concat(chunks);
    let reqBody = null;
    try { reqBody = JSON.parse(rawBody.toString('utf8')); } catch { /* forwarded untouched */ }

    let path = req.url;
    let cwd = null;
    const prefix = pathOf(req).match(CWD_PREFIX);
    if (prefix) {
      try { cwd = Buffer.from(prefix[1], 'base64url').toString('utf8'); } catch { /* ignore bad prefix */ }
      path = req.url.replace(CWD_PREFIX, '') || '/';
    }

    const headers = { ...req.headers, host: upstream.hostname, 'accept-encoding': 'identity' };
    const isChat = /\/chat\/completions$/.test(pathOf(req)) && reqBody && Array.isArray(reqBody.messages);
    const stream = isChat && reqBody.stream === true;
    const meta = { cwd, client: isChat ? detectClient(req.headers['user-agent'], reqBody) : null };

    // Streaming responses only carry token usage when asked; add it where the upstream is known to support it.
    if (stream && upstream.injectUsage && !reqBody.stream_options?.include_usage) {
      rawBody = Buffer.from(JSON.stringify({ ...reqBody, stream_options: { ...reqBody.stream_options, include_usage: true } }), 'utf8');
    }
    headers['content-length'] = String(rawBody.length);
    delete headers['transfer-encoding'];

    const startedAt = Date.now();
    let firstTokenAt = null;
    if (isChat) emit('turn_started', { session_id: resolveSession(reqBody, meta).sessionId, request_id: randomUUID(), model: reqBody.model ?? null, started_at: startedAt });

    const proxyReq = (upstream.tls ? https : http).request(
      { hostname: upstream.hostname, port: upstream.port, path: upstream.basePath + path, method: req.method, headers },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        const out = [];
        proxyRes.on('data', (chunk) => { firstTokenAt ??= Date.now(); res.write(chunk); out.push(chunk); });
        proxyRes.on('end', () => {
          res.end();
          if (!isChat || proxyRes.statusCode !== 200) return;
          const text = Buffer.concat(out).toString('utf8');
          const timing = { startedAt, firstTokenAt, endedAt: Date.now() };
          (stream ? parseChatStream : parseChatCompletion)(reqBody, text, timing, meta);
        });
        proxyRes.on('error', (err) => console.error('[openai-proxy] upstream response error:', err.message));
      },
    );
    proxyReq.on('error', (err) => {
      console.error('[openai-proxy] upstream connection error:', err.message);
      if (!res.headersSent) { res.writeHead(502); res.end('Bad Gateway'); }
    });
    proxyReq.end(rawBody);
  });
}
