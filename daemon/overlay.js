// Context overlay (Phase 15, #59): ordered per-session rules applied to every request, because the
// client resends its own history each turn and would otherwise undo an edit. Pure functions here;
// storage is in db/store.js and the proxy wiring in overlayHook (bottom).
//
// Rule kinds (params):
//   append_user_message   { text }                 inject guidance; kept at the same point in history on later turns
//   replace_message       { index, text }          replace a plain-text message (index = client history index)
//   truncate_tool_result  { max_chars, tool_use_id? }  cut tool results (one, or all when no id) to max_chars
//   delete_message        { indices: number[] }    drop messages (a tool call and its result must go together)
//
// Index-based rules refer to the client's original history, so they are all resolved against it
// first; injected messages never shift them.
import { analyzeContext } from './context.js';
import { estimateCost } from './pricing/models.js';
import { emit } from './events.js';
import { getOverlayRules, setOverlayAnchor, addOverlayAudit } from './db/store.js';

export const KINDS = ['append_user_message', 'replace_message', 'truncate_tool_result', 'delete_message'];

const blocksOf = (m) => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content ?? []);
const isThinking = (b) => b.type === 'thinking' || b.type === 'redacted_thinking';
const chars = (v) => JSON.stringify(v ?? '').length;

/** Static checks on a rule before it is stored. Returns a list of problems. */
export function checkRule(kind, params = {}) {
  if (!KINDS.includes(kind)) return [`Unknown rule kind "${kind}"`];
  const p = [];
  const isIndex = (n) => Number.isInteger(n) && n >= 0;
  if (kind === 'append_user_message' && !(typeof params.text === 'string' && params.text.trim())) p.push('text is required');
  if (kind === 'replace_message') {
    if (!isIndex(params.index)) p.push('index must be a non-negative integer');
    if (typeof params.text !== 'string' || !params.text.trim()) p.push('text is required');
  }
  if (kind === 'truncate_tool_result') {
    if (!Number.isInteger(params.max_chars) || params.max_chars < 0) p.push('max_chars must be a non-negative integer');
    if (params.tool_use_id !== undefined && typeof params.tool_use_id !== 'string') p.push('tool_use_id must be a string');
  }
  if (kind === 'delete_message' && !(Array.isArray(params.indices) && params.indices.length && params.indices.every(isIndex))) p.push('indices must be a non-empty list of non-negative integers');
  return p;
}

/** Problems that would make the Messages API reject (or silently change) the request. */
export function validateRequest(body, original = body) {
  const problems = [];
  const msgs = body.messages;
  if (!Array.isArray(msgs) || !msgs.length) return ['request has no messages'];
  if (msgs[0].role !== 'user') problems.push('conversation must start with a user message');
  msgs.forEach((m, i) => {
    // Claude Code 2.x also sends role:"system" messages (reminders, tool additions); they are valid as they are.
    if (!['user', 'assistant', 'system'].includes(m.role)) problems.push(`message ${i} has invalid role "${m.role}"`);
    if (typeof m.content === 'string' ? !m.content.trim() : !(Array.isArray(m.content) && m.content.length)) problems.push(`message ${i} is empty`);
  });

  msgs.forEach((m, i) => {
    const uses = m.role === 'assistant' ? blocksOf(m).filter((b) => b.type === 'tool_use').map((b) => b.id) : [];
    const next = msgs[i + 1];
    const results = new Set(next?.role === 'user' ? blocksOf(next).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id) : []);
    for (const id of uses) if (!results.has(id)) problems.push(`tool call ${id} has no result in the next message`);
    if (m.role === 'user') {
      const prevUses = new Set(msgs[i - 1]?.role === 'assistant' ? blocksOf(msgs[i - 1]).filter((b) => b.type === 'tool_use').map((b) => b.id) : []);
      for (const b of blocksOf(m)) if (b.type === 'tool_result' && !prevUses.has(b.tool_use_id)) problems.push(`tool result ${b.tool_use_id} has no matching tool call before it`);
    }
  });

  const thinking = (b) => (b.messages ?? []).flatMap((m) => (m.role === 'assistant' ? blocksOf(m).filter(isThinking).map((t) => JSON.stringify(t)) : [])).sort();
  if (JSON.stringify(thinking(body)) !== JSON.stringify(thinking(original))) problems.push('signed thinking blocks must not be edited or removed');
  return problems;
}

// Index of the user message guidance should join: the last message, or the user message just before
// trailing role:"system" messages (Claude Code ends its history with those). -1 means add a new message.
function userTarget(msgs) {
  let i = msgs.length - 1;
  while (i >= 0 && msgs[i].role === 'system') i--;
  return i >= 0 && msgs[i].role === 'user' ? i : -1;
}

function pushUser(out, text) {
  const i = userTarget(out);
  if (i >= 0) out[i].content = [...blocksOf(out[i]), { type: 'text', text }];
  else out.push({ role: 'user', content: [{ type: 'text', text }] });
}

function truncateContent(content, max) {
  const mark = (n) => `\n… [truncated by open-trace: ${n} characters removed]`;
  if (typeof content === 'string') return content.length > max ? content.slice(0, max) + mark(content.length - max) : content;
  if (!Array.isArray(content)) return content;
  let left = max;
  return content.map((b) => {
    if (b.type !== 'text') return b;
    const keep = Math.max(0, left);
    left -= b.text.length;
    return b.text.length > keep ? { ...b, text: b.text.slice(0, keep) + mark(b.text.length - keep) } : b;
  });
}

/**
 * Apply rules (oldest first) to a request body. Never mutates the input.
 * @param {{id: number, kind: string, params: object, anchor: number|null}[]} rules
 * @returns {{body: object, effects: {rule_id: number, ok: boolean, note: string, anchor?: number}[], problems: string[]}}
 *   body is the original body when nothing applied or the result is invalid (problems non-empty).
 */
export function applyRules(body, rules) {
  const original = Array.isArray(body.messages) ? body.messages : [];
  const msgs = structuredClone(original);
  const deleted = new Set();
  const appends = []; // { after, text, rule }
  const effects = [];
  const done = (rule, note, extra = {}) => effects.push({ rule_id: rule.id, ok: true, note, ...extra });
  const skip = (rule, note) => effects.push({ rule_id: rule.id, ok: false, note });

  for (const rule of rules) {
    const { kind, params } = rule;
    if (kind === 'replace_message') {
      const m = msgs[params.index];
      if (!m) skip(rule, `message ${params.index} does not exist`);
      else if (blocksOf(m).some((b) => b.type !== 'text')) skip(rule, `message ${params.index} has tool calls, results or thinking and cannot be replaced`);
      else { const before = chars(m.content); m.content = params.text; done(rule, `replaced message ${params.index} (${before} → ${chars(params.text)} chars)`); }
    } else if (kind === 'truncate_tool_result') {
      let cut = 0;
      for (const m of msgs) {
        if (m.role !== 'user' || !Array.isArray(m.content)) continue;
        for (const b of m.content) {
          if (b.type !== 'tool_result' || (params.tool_use_id && b.tool_use_id !== params.tool_use_id)) continue;
          const before = chars(b.content);
          b.content = truncateContent(b.content, params.max_chars);
          cut += before - chars(b.content);
        }
      }
      if (cut > 0) done(rule, `removed ~${cut} characters from tool results`);
      else skip(rule, 'no tool result was longer than the limit');
    } else if (kind === 'delete_message') {
      const bad = params.indices.find((i) => !msgs[i] || blocksOf(msgs[i]).some(isThinking));
      if (bad !== undefined) skip(rule, msgs[bad] ? `message ${bad} has thinking blocks and cannot be deleted` : `message ${bad} does not exist`);
      else { params.indices.forEach((i) => deleted.add(i)); done(rule, `deleted message${params.indices.length > 1 ? 's' : ''} ${params.indices.join(', ')}`); }
    } else if (kind === 'append_user_message') {
      // First use anchors the injection to the end of the history as it is now; later turns put it back at the same point.
      const anchor = rule.anchor ?? msgs.length;
      appends.push({ after: Math.max(1, anchor), text: params.text });
      done(rule, `injected ${params.text.length} characters after message ${Math.max(1, anchor)}`, { anchor });
    }
  }

  const out = [];
  msgs.forEach((m, i) => {
    if (!deleted.has(i)) out.push(m);
    for (const a of appends) if (a.after === i + 1) pushUser(out, a.text);
  });
  for (const a of appends) if (a.after > msgs.length) pushUser(out, a.text);

  const result = { ...body, messages: out };
  const problems = validateRequest(result, body);
  return { body: problems.length ? body : result, effects, problems };
}

/** Lowest original message index a rule touches (cache prefix up to it stays valid). null = unknown. */
export function editsFrom(rule, body) {
  const msgs = body.messages ?? [];
  const { kind, params } = rule;
  if (kind === 'replace_message') return params.index;
  if (kind === 'delete_message') return Math.min(...params.indices);
  if (kind === 'append_user_message') {
    const at = Math.max(1, rule.anchor ?? msgs.length);
    const target = userTarget(msgs.slice(0, at));
    return target >= 0 ? target : at - 1; // a new message re-writes the cached tail (the last message carries the cache breakpoint)
  }
  const hit = msgs.findIndex((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result' && (!params.tool_use_id || b.tool_use_id === params.tool_use_id) && chars(b.content) > params.max_chars));
  return hit === -1 ? null : hit;
}

/**
 * One-time extra equiv. cost: tokens from the first edited message onward must be re-written to the
 * prompt cache (cache-write rate) instead of read from it (cache-read rate). Estimate from chars/4.
 */
export function cacheImpact(body, fromIndex) {
  if (fromIndex === null || fromIndex === undefined) return { from_index: null, tokens: 0, extra_equiv_cost_usd: 0 };
  const tokens = Math.round(analyzeContext(body).messages.slice(fromIndex).reduce((a, m) => a + m.c, 0) / 4);
  const model = body.model;
  const extra = estimateCost(model, { cache_write_tokens: tokens }) - estimateCost(model, { cache_read_tokens: tokens });
  return { from_index: fromIndex, tokens, extra_equiv_cost_usd: extra };
}

// ─── Proxy wiring ─────────────────────────────────────────────────────────────

// Global kill switch: while on, nothing is modified.
let passthrough = process.env.OPEN_TRACE_PASSTHROUGH === '1';
export const isPassthrough = () => passthrough;
export function setPassthrough(on) {
  passthrough = Boolean(on);
  addOverlayAudit({ action: passthrough ? 'passthrough_on' : 'passthrough_off' });
  emit('overlay_changed', { passthrough });
}

/** Request hook: apply the session's rules. An invalid result is never forwarded; the original request is. */
export function overlayHook({ sessionId, requestId, body }) {
  if (passthrough || !sessionId) return undefined;
  const rules = getOverlayRules(sessionId);
  if (!rules.length) return undefined;

  const { body: out, effects, problems } = applyRules(body, rules);
  if (problems.length) {
    addOverlayAudit({ session_id: sessionId, request_id: requestId, action: 'rejected', detail: `Overlay not applied, request forwarded unchanged: ${problems.join('; ')}` });
    emit('overlay_applied', { session_id: sessionId, request_id: requestId, applied: 0 });
    return undefined;
  }
  for (const e of effects) {
    if (e.anchor !== undefined) setOverlayAnchor(e.rule_id, e.anchor);
    addOverlayAudit({ session_id: sessionId, request_id: requestId, rule_id: e.rule_id, action: e.ok ? 'applied' : 'skipped', detail: e.note });
  }
  emit('overlay_applied', { session_id: sessionId, request_id: requestId, applied: effects.filter((e) => e.ok).length });
  return { body: out };
}
