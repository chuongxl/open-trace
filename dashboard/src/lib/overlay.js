const KIND_LABEL = {
  append_user_message: 'Inject',
  replace_message: 'Replace',
  truncate_tool_result: 'Trim results',
  delete_message: 'Delete',
}

/** One-line description of a stored rule. */
export function describeRule(rule) {
  const p = rule.params
  const label = KIND_LABEL[rule.kind] ?? rule.kind
  switch (rule.kind) {
    case 'append_user_message':
      return `${label}: “${p.text.length > 80 ? p.text.slice(0, 80) + '…' : p.text}”`
    case 'replace_message':
      return `${label} message ${p.index}`
    case 'truncate_tool_result':
      return `${label} to ${p.max_chars} characters${p.tool_use_id ? ` (call ${p.tool_use_id})` : ' (all)'}`
    case 'delete_message':
      return `${label} message${p.indices.length > 1 ? 's' : ''} ${p.indices.join(', ')}`
    default:
      return label
  }
}

/** Summary line for a dry-run result from the daemon. */
export function describePreview(preview, formatCost) {
  if (!preview.valid) return `Not valid: ${preview.problems.join('; ')}`
  const { tokens, extra_equiv_cost_usd } = preview.cache
  const cache = tokens > 0 ? ` · re-caches ~${tokens} tokens, ~${formatCost(extra_equiv_cost_usd)} extra equiv. cost (one-time)` : ''
  return `Valid · ${preview.messages_before} → ${preview.messages_after} messages${cache}`
}
