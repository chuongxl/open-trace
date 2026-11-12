import { TOOLS } from '../lib/tools.js'

export default function ToolBadge({ tool }) {
  const meta = TOOLS[tool] ?? { label: tool, className: 'bg-neutral-800 text-neutral-300' }
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${meta.className}`}>
      {meta.label}
    </span>
  )
}
