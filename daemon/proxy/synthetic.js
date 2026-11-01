// A locally made assistant reply that ends the turn (stop_reason end_turn), so a client halts
// cleanly instead of seeing an error. Streaming and non-streaming shapes follow the Messages API.
import { randomUUID } from 'crypto';

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

/** @returns {{headers: object, body: string}} */
export function syntheticEndTurn({ model, stream, text }) {
  const id = `msg_opentrace_${randomUUID().replace(/-/g, '')}`;
  const base = { id, type: 'message', role: 'assistant', model: model ?? 'unknown' };

  if (!stream) {
    return {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }),
    };
  }
  return {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    body:
      sse('message_start', { message: { ...base, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }) +
      sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
      sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }) +
      sse('content_block_stop', { index: 0 }) +
      sse('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } }) +
      sse('message_stop', {}),
  };
}
