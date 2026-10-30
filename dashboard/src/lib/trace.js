const SUMMARY_KEYS = ['file_path', 'filePath', 'path', 'command', 'query', 'pattern', 'url', 'description']
const SUMMARY_MAX = 80

export function toolKind(name) {
  if (typeof name !== 'string') return 'tool'
  if (name.startsWith('mcp__')) return 'mcp'
  if (name.toLowerCase() === 'bash') return 'bash'
  return 'tool'
}

// mcp__github__search_issues -> github/search_issues
export function displayName(name) {
  return typeof name === 'string' && name.startsWith('mcp__') ? name.slice(5).replace('__', '/') : name
}

function truncate(s) {
  return s.length > SUMMARY_MAX ? s.slice(0, SUMMARY_MAX) + '…' : s
}

/** One-line description of a tool input: the most telling string field. */
export function summarizeInput(input) {
  if (typeof input !== 'string' || input === '') return ''
  let parsed
  try {
    parsed = JSON.parse(input)
  } catch {
    return truncate(input)
  }
  if (typeof parsed === 'string') return truncate(parsed)
  if (!parsed || typeof parsed !== 'object') return ''
  const key = SUMMARY_KEYS.find((k) => typeof parsed[k] === 'string')
  const value = key ? parsed[key] : Object.values(parsed).find((v) => typeof v === 'string')
  return value ? truncate(value) : ''
}

export function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

export function prettyJson(text) {
  if (typeof text !== 'string') return ''
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/**
 * Turn a prompt's raw tool_calls rows into trace steps.
 * Rows sharing a call_order are one step (OpenCode stores the call and its result
 * as two rows). Timing is only reported when the rows carry real, distinct
 * timestamps: the Claude proxy stamps every call with the storing time, so showing
 * "+0ms" there would look measured when it is not.
 */
export function buildTrace(prompt, toolCalls) {
  const groups = new Map()
  for (const row of toolCalls) {
    if (!groups.has(row.call_order)) groups.set(row.call_order, [])
    groups.get(row.call_order).push(row)
  }
  const hasTiming = new Set(toolCalls.map((r) => r.timestamp)).size > 1 || toolCalls.some((r) => r.duration_ms != null)

  return [...groups.keys()]
    .sort((a, b) => a - b)
    .map((order) => {
      const rows = groups.get(order)
      const times = rows.map((r) => r.timestamp)
      const first = Math.min(...times)
      const span = Math.max(...times) - first
      const durationMs = rows.length > 1 && span > 0 ? span : (rows.length === 1 ? rows[0].duration_ms ?? null : null)
      const name = rows[0].name
      return {
        order,
        name,
        kind: toolKind(name),
        input: rows.find((r) => r.input != null)?.input ?? null,
        output: rows.find((r) => r.output != null)?.output ?? null,
        startMs: hasTiming ? Math.max(0, first - prompt.timestamp) : null,
        durationMs,
      }
    })
}
