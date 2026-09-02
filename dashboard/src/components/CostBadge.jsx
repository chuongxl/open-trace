import { costTier } from '../lib/format.js'

const COLORS = {
  green: 'bg-green-900/60 text-green-300',
  yellow: 'bg-yellow-900/60 text-yellow-300',
  red: 'bg-red-900/60 text-red-300',
}

export default function CostBadge({ cost }) {
  const tier = costTier(cost)
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${COLORS[tier]}`}>
      ${cost.toFixed(2)}
    </span>
  )
}
