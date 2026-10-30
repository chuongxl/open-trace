// Context accounting for one Messages request (Phase 13b, #56).
// The client resends its whole history every turn, so the request body is the agent's entire
// context. We measure it in characters (the UI shows chars/4 as a "~" token estimate) by section,
// and keep a compact per-message summary so two consecutive requests can be diffed later
// without storing the (large) bodies.

const len = (v) => (typeof v === 'string' ? v.length : JSON.stringify(v ?? '').length);

const isClaudeMd = (b) => b.type === 'text' && typeof b.text === 'string'
  && b.text.includes('<system-reminder>') && b.text.includes('CLAUDE.md');

/**
 * @returns {{sections: {system, tools, claude_md, history, tool_results}, message_count: number,
 *            messages: Array<{r: 'user'|'assistant', k: string, c: number, m: number, n?: string}>}}
 *   m = size of the largest single block in the message; n = tool name for tool_use/tool_result.
 */
export function analyzeContext(reqBody) {
  const sections = { system: len(Array.isArray(reqBody.system) ? reqBody.system.map(b => b.text ?? '').join('') : reqBody.system ?? ''), tools: len(reqBody.tools ?? []), claude_md: 0, history: 0, tool_results: 0 };
  const toolNames = new Map();
  const messages = [];

  for (const msg of Array.isArray(reqBody.messages) ? reqBody.messages : []) {
    const blocks = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : (msg.content ?? []);
    const entry = { r: msg.role, k: 'text', c: 0, m: 0 };
    for (const b of blocks) {
      let size, section = 'history', kind = b.type === 'tool_use' ? 'tool_use' : 'text';
      if (b.type === 'tool_use') {
        toolNames.set(b.id, b.name);
        size = len(b.input) + len(b.name);
      } else if (b.type === 'tool_result') {
        section = 'tool_results'; kind = 'tool_result';
        size = len(b.content);
      } else if (isClaudeMd(b)) {
        section = 'claude_md'; kind = 'claude_md';
        size = b.text.length;
      } else {
        size = b.type === 'text' ? len(b.text) : len(b);
      }
      sections[section] += size;
      entry.c += size;
      if (size >= entry.m) {
        entry.m = size; entry.k = kind;
        const name = kind === 'tool_result' ? toolNames.get(b.tool_use_id) : kind === 'tool_use' ? b.name : undefined;
        if (name) entry.n = name; else delete entry.n;
      }
    }
    messages.push(entry);
  }
  return { sections, message_count: messages.length, messages };
}

/**
 * What changed between two consecutive requests of the same session.
 * History is append-only unless the client compacted it (fewer messages than before).
 */
export function diffContext(prev, cur) {
  if (!prev) return null;
  const delta = Object.fromEntries(Object.keys(cur.sections).map((k) => [k, cur.sections[k] - prev.sections[k]]));
  const compacted = cur.message_count < prev.message_count;
  const added = compacted ? cur.messages : cur.messages.slice(prev.message_count);
  const biggest = added.filter((m) => m.k === 'tool_result').sort((a, b) => b.m - a.m)[0];
  return {
    delta,
    compacted,
    added_messages: added.length,
    largest_tool_result: biggest ? { name: biggest.n ?? null, chars: biggest.m } : null,
  };
}
