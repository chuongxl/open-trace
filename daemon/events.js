// In-process event bus feeding GET /api/live (Phase 13a, #56).
// Event types: turn_started, turn_finished, session_updated.
import { EventEmitter } from 'events';

const bus = new EventEmitter();
bus.setMaxListeners(0); // one listener per open dashboard tab

export function emit(type, data) { bus.emit('event', { type, data, at: Date.now() }); }
export function subscribe(fn) { bus.on('event', fn); return () => bus.off('event', fn); }
