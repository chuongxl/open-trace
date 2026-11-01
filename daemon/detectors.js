// Stuck-agent detectors (Phase 13c, #57). After every stored turn, look at the session's recent
// activity and raise an `alert` (stored once per condition, pushed on /api/live). Observe only:
// nothing is paused or changed here; Phase 14 can use alerts as breakpoints.
import { config } from './config.js';
import { subscribe, emit } from './events.js';
import { getSession, getRecentToolCalls, insertAlert } from './db/store.js';

const ERROR_WINDOW = 20;
const snippet = (s, n = 80) => (s.length > n ? s.slice(0, n) + '…' : s).replace(/\s+/g, ' ');

/** Same tool + same input, `n` or more times in a row, newest first. One alert per run (keyed by its oldest call). */
export function repeatedCall(calls, n) {
  if (!n || calls.length < n) return null;
  let run = 1;
  while (run < calls.length && calls[run].name === calls[0].name && calls[run].input === calls[0].input) run++;
  if (run < n) return null;
  return { kind: 'repeat_call', dedupe_key: `repeat_call:${calls[run - 1].id}`, message: `${calls[0].name} called ${run}× in a row with the same input` };
}

/** The same failing result (same tool, same start of output) `n` or more times in the last 20 calls. */
export function repeatedError(calls, n) {
  if (!n) return null;
  const groups = new Map();
  for (const c of calls.slice(0, ERROR_WINDOW)) {
    if (!c.is_error) continue;
    const sig = `${c.name}\u0000${(c.output ?? '').slice(0, 200)}`;
    const g = groups.get(sig) ?? { name: c.name, output: c.output ?? '', ids: [] };
    g.ids.push(c.id);
    groups.set(sig, g);
  }
  const worst = [...groups.values()].filter((g) => g.ids.length >= n).sort((a, b) => b.ids.length - a.ids.length)[0];
  if (!worst) return null;
  return { kind: 'repeat_error', dedupe_key: `repeat_error:${worst.ids[worst.ids.length - 1]}`, message: `${worst.name} failed ${worst.ids.length}× with the same error: ${snippet(worst.output)}` };
}

/** Prompt tokens of the latest request (fresh + cached) against the window. Once per session and threshold. */
export function contextHigh({ input_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0 }, { contextPct, contextWindowTokens }) {
  if (!contextPct || !contextWindowTokens) return null;
  const used = input_tokens + cache_read_tokens + cache_write_tokens;
  const pct = (used / contextWindowTokens) * 100;
  if (pct < contextPct) return null;
  return { kind: 'context_high', dedupe_key: `context_high:${contextPct}`, message: `Context at ${Math.round(pct)}% of the window (~${Math.round(used / 1000)}k of ${Math.round(contextWindowTokens / 1000)}k tokens)` };
}

/** Session equiv. cost past the threshold. Once per session and threshold. */
export function costHigh(costUsd, threshold) {
  if (!threshold || costUsd < threshold) return null;
  return { kind: 'cost_high', dedupe_key: `cost_high:${threshold}`, message: `Session equiv. cost $${costUsd.toFixed(2)} passed the $${threshold} alert threshold` };
}

export function evaluateTurn(turn, thresholds = config.detectors) {
  const session = getSession(turn.session_id);
  if (!session) return [];
  const calls = getRecentToolCalls(turn.session_id, 30);
  const found = [
    repeatedCall(calls, thresholds.repeatCalls),
    repeatedError(calls, thresholds.repeatErrors),
    contextHigh(turn, thresholds),
    costHigh(session.equiv_cost_usd ?? 0, thresholds.costUsd),
  ].filter(Boolean);

  const raised = [];
  for (const a of found) {
    const row = insertAlert({ session_id: turn.session_id, ...a });
    if (row) { raised.push(row); emit('alert', row); }
  }
  return raised;
}

/** Evaluate every finished turn. Returns the unsubscribe function. */
export function startDetectors() {
  return subscribe((e) => {
    if (e.type !== 'turn_finished') return;
    try { evaluateTurn(e.data); } catch (err) { console.error('[detectors] failed:', err.message); }
  });
}
