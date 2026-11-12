// Tools open-trace records, in display order. `context`: requests carry a body we can break down by section
// (the context inspector); `control`: the session debugger can pause/stop it (Claude Code only).
export const TOOLS = {
  'claude-code': { label: 'Claude Code', className: 'bg-orange-900/60 text-orange-300', context: true, control: true },
  opencode: { label: 'OpenCode', className: 'bg-sky-900/60 text-sky-300' },
  copilot: { label: 'Copilot', className: 'bg-purple-900/60 text-purple-300' },
  aider: { label: 'Aider', className: 'bg-lime-900/60 text-lime-300', context: true },
  continue: { label: 'Continue', className: 'bg-teal-900/60 text-teal-300', context: true },
  cline: { label: 'Cline', className: 'bg-pink-900/60 text-pink-300', context: true },
  'roo-code': { label: 'Roo Code', className: 'bg-rose-900/60 text-rose-300', context: true },
  'openai-compat': { label: 'OpenAI-compatible', className: 'bg-neutral-800 text-neutral-300', context: true },
}

export const hasContext = (tool) => TOOLS[tool]?.context === true
export const canControl = (tool) => TOOLS[tool]?.control === true
