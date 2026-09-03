const TOOLS = {
  'claude-code': { label: 'Claude Code', className: 'bg-orange-900/60 text-orange-300' },
  opencode: { label: 'OpenCode', className: 'bg-sky-900/60 text-sky-300' },
  copilot: { label: 'Copilot', className: 'bg-purple-900/60 text-purple-300' },
}

export default function ToolBadge({ tool }) {
  const meta = TOOLS[tool] ?? { label: tool, className: 'bg-neutral-800 text-neutral-300' }
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${meta.className}`}>
      {meta.label}
    </span>
  )
}
