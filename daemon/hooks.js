// The proxy's single request hook: the debugger decides whether to hold or stop first,
// then the overlay edits whatever is released.
import { debugHook } from './debugger.js';
import { overlayHook } from './overlay.js';

export async function pipelineHook(ctx) {
  const held = await debugHook(ctx);
  if (held?.respond) return held;
  return overlayHook({ ...ctx, body: held?.body ?? ctx.body });
}
