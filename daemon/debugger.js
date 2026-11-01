// Session debugger controls (Phase 14, #58): pause, step, continue and stop a Claude Code session
// by holding its next request in the proxy. State is in memory, per session.
//
//   running  → requests pass through
//   pausing  → pause requested, waiting for the next request boundary (a response is never cut mid-stream)
//   paused   → at least one request is held
//   stopping → the next tool-loop continuation is answered with a synthetic end_turn (armed for ARM_MS)
//
// Only requests that carry tools are held: Claude Code's small background calls (titles, summaries)
// pass through, so they cannot block a pause.
import { emit, subscribe } from './events.js';

export const STOP_TEXT = 'Stopped by open-trace.';
const ARM_MS = 60_000;

const sessions = new Map();
const get = (id) => {
  let s = sessions.get(id);
  if (!s) { s = { mode: 'running', held: new Map(), armedUntil: 0, breakOnAlert: false }; sessions.set(id, s); }
  return s;
};

// A stop armed while nothing is held lapses, so it cannot hit a prompt the engineer types much later.
function refresh(s) {
  if (s.mode === 'stop' && Date.now() > s.armedUntil) s.mode = 'running';
  return s;
}

/** A tool-loop continuation: the last user message answers tool calls rather than carrying a new prompt. */
export function isContinuation(body) {
  // Claude Code 2.x appends a role:"system" message after the tool results; look at the last user message.
  const last = Array.isArray(body?.messages) ? [...body.messages].reverse().find((m) => m.role === 'user') : null;
  return last?.role === 'user' && Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result');
}

export function describe(sessionId) {
  const s = refresh(get(sessionId));
  const state = s.mode === 'stop' ? 'stopping' : s.mode === 'pause' ? (s.held.size ? 'paused' : 'pausing') : 'running';
  return {
    session_id: sessionId,
    state,
    break_on_alert: s.breakOnAlert,
    held: [...s.held.values()].map(({ requestId, model, heldAt, messageCount, continuation }) => ({ request_id: requestId, model, held_at: heldAt, message_count: messageCount, continuation })),
  };
}

function publish(sessionId, reason) {
  emit('debug_state', { ...describe(sessionId), reason });
}

/** Request hook for the proxy (see setRequestHook). */
export async function debugHook({ requestId, sessionId, body, signal }) {
  if (!sessionId || !body.tools?.length) return undefined;
  const s = refresh(get(sessionId));

  if (s.mode === 'stop' && isContinuation(body)) {
    s.mode = 'running';
    publish(sessionId, 'stopped');
    return { respond: { text: STOP_TEXT } };
  }
  if (s.mode !== 'pause') return undefined;

  return new Promise((resolve) => {
    s.held.set(requestId, { requestId, model: body.model ?? null, heldAt: Date.now(), messageCount: body.messages?.length ?? 0, continuation: isContinuation(body), body, resolve });
    publish(sessionId, 'held');
    signal.addEventListener('abort', () => {
      if (s.held.delete(requestId)) publish(sessionId, 'client_left');
    });
  });
}

const release = (s, requestId, outcome) => {
  const entry = s.held.get(requestId);
  s.held.delete(requestId);
  entry.resolve(outcome);
};

/** The request body of the oldest held request, for previewing an overlay edit against it. */
export function heldBody(sessionId) {
  return get(sessionId).held.values().next().value?.body ?? null;
}

export function pause(sessionId) {
  const s = get(sessionId);
  s.mode = 'pause';
  publish(sessionId, 'pause');
  return describe(sessionId);
}

/** Release the oldest held request; the session stays in pause mode and holds the next one. */
export function step(sessionId) {
  const s = get(sessionId);
  if (!s.held.size) return { error: 'Nothing is held. Pause the session and wait for its next request first.' };
  release(s, s.held.keys().next().value, undefined);
  publish(sessionId, 'step');
  return describe(sessionId);
}

/** Release everything and stop holding. */
export function resume(sessionId) {
  const s = get(sessionId);
  s.mode = 'running';
  for (const id of [...s.held.keys()]) release(s, id, undefined);
  publish(sessionId, 'continue');
  return describe(sessionId);
}

/** Answer held requests with a synthetic end_turn; with nothing held, arm the next continuation. */
export function stop(sessionId) {
  const s = get(sessionId);
  if (s.held.size) {
    s.mode = 'running';
    for (const id of [...s.held.keys()]) release(s, id, { respond: { text: STOP_TEXT } });
    publish(sessionId, 'stopped');
  } else {
    s.mode = 'stop';
    s.armedUntil = Date.now() + ARM_MS;
    publish(sessionId, 'stop');
  }
  return describe(sessionId);
}

export function setBreakOnAlert(sessionId, enabled) {
  get(sessionId).breakOnAlert = Boolean(enabled);
  publish(sessionId, 'break_on_alert');
  return describe(sessionId);
}

/** Conditional breakpoint: a detector alert pauses sessions that opted in. Returns unsubscribe. */
export function startDebugger() {
  return subscribe((e) => {
    if (e.type !== 'alert') return;
    const s = sessions.get(e.data.session_id);
    if (s?.breakOnAlert && refresh(s).mode === 'running') {
      s.mode = 'pause';
      publish(e.data.session_id, 'alert');
    }
  });
}
