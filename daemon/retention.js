// Retention (#64): with RETENTION_DAYS > 0, rows older than that are deleted at startup and every 6 hours.
import { config } from './config.js';
import { pruneBefore } from './db/store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const EVERY_MS = 6 * 60 * 60 * 1000;

/** Epoch ms before which data is expired, or null when retention is off. */
export function retentionCutoff(days = config.retentionDays, now = Date.now()) {
  return days > 0 ? now - days * DAY_MS : null;
}

export function pruneExpired(days = config.retentionDays, now = Date.now()) {
  const cutoff = retentionCutoff(days, now);
  if (cutoff === null) return null;
  const result = pruneBefore(cutoff);
  if (result.prompts || result.sessions) {
    console.log(`[retention] deleted ${result.prompts} prompts, ${result.toolCalls} tool calls, ${result.sessions} sessions older than ${days} days`);
  }
  return result;
}

/** Start the periodic prune. Returns the timer (unref'd) or null when retention is off. */
export function startRetention() {
  if (retentionCutoff() === null) return null;
  const run = () => { try { pruneExpired(); } catch (err) { console.error('[retention] prune failed:', err.message); } };
  run();
  return setInterval(run, EVERY_MS).unref();
}
