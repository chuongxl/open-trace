const HOME_PREFIX = /^\/(?:Users|home)\/[^/]+/

export function shortenHomePath(path) {
  if (typeof path !== 'string') return ''
  return path.replace(HOME_PREFIX, '~')
}

export function costTier(cost) {
  if (cost >= 10) return 'red'
  if (cost >= 1) return 'yellow'
  return 'green'
}

export function formatTokenCount(n) {
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

export function tokenProportions({ input = 0, output = 0, cache = 0 }) {
  const total = input + output + cache
  if (total <= 0) return { inputPct: 0, outputPct: 0, cachePct: 0 }
  return {
    inputPct: (input / total) * 100,
    outputPct: (output / total) * 100,
    cachePct: (cache / total) * 100,
  }
}
