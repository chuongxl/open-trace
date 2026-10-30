// Section order = bar order. Sizes are characters from the daemon; tokens are a ~chars/4 estimate.
export const SECTIONS = [
  { key: 'system', label: 'System prompt', color: 'bg-violet-500' },
  { key: 'tools', label: 'Tool definitions', color: 'bg-sky-500' },
  { key: 'claude_md', label: 'CLAUDE.md', color: 'bg-emerald-500' },
  { key: 'history', label: 'Conversation', color: 'bg-amber-500' },
  { key: 'tool_results', label: 'Tool results', color: 'bg-rose-500' },
]

export const estTokens = (chars) => Math.round(chars / 4)

/** Bar segments for one turn, as percentages of the largest turn in the session (so growth is visible). */
export function barSegments(sections, maxTotal) {
  return SECTIONS.map((s) => ({ ...s, tokens: estTokens(sections[s.key] ?? 0), pct: maxTotal > 0 ? ((sections[s.key] ?? 0) / maxTotal) * 100 : 0 }))
}

/** "+~1.2k tool results, +~40 conversation" from a diff's per-section char deltas; empty when nothing changed. */
export function describeDelta(delta, fmt) {
  if (!delta) return ''
  return SECTIONS.filter((s) => delta[s.key] !== 0)
    .sort((a, b) => Math.abs(delta[b.key]) - Math.abs(delta[a.key]))
    .map((s) => `${delta[s.key] > 0 ? '+' : '−'}~${fmt(Math.abs(estTokens(delta[s.key])))} ${s.label.toLowerCase()}`)
    .join(', ')
}
