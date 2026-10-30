import { useState } from 'react'
import { Wrench, Globe, Terminal, Bot, ChevronRight, ChevronDown } from 'lucide-react'
import { buildTrace, displayName, summarizeInput, formatDuration, prettyJson } from '../lib/trace.js'
import { formatTokenCount } from '../lib/format.js'

const ICONS = { tool: Wrench, mcp: Globe, bash: Terminal }

function Step({ step }) {
  const [open, setOpen] = useState(false)
  const Icon = ICONS[step.kind]
  const summary = summarizeInput(step.input)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <li className="border-b border-neutral-800 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-800/60"
      >
        <Chevron size={14} className="shrink-0 text-neutral-500" />
        <Icon size={14} className="shrink-0 text-neutral-400" />
        <span className="font-mono text-neutral-200">
          {step.kind}:{displayName(step.name)}
        </span>
        {summary && <span className="truncate text-neutral-500">← {summary}</span>}
        <span className="ml-auto shrink-0 text-xs text-neutral-500">
          {step.startMs !== null && <>+{formatDuration(step.startMs)}</>}
          {step.durationMs !== null && <> · {formatDuration(step.durationMs)}</>}
          {step.startMs === null && step.durationMs === null && <>#{step.order + 1}</>}
        </span>
      </button>
      {open && (
        <div className="space-y-2 bg-neutral-950 px-4 py-3">
          <Payload label="Input" text={step.input} empty="no input captured" />
          <Payload label="Output" text={step.output} empty="no output captured" />
        </div>
      )}
    </li>
  )
}

function Payload({ label, text, empty }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      {text == null ? (
        <p className="text-sm italic text-neutral-600">{empty}</p>
      ) : (
        <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-neutral-900 p-2 text-xs text-neutral-300">
          {prettyJson(text)}
        </pre>
      )}
    </div>
  )
}

export default function AgentTrace({ prompt, toolCalls }) {
  const steps = buildTrace(prompt, toolCalls)
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium text-neutral-300">Agent trace</h2>
      <ol className="rounded border border-neutral-800 bg-neutral-900">
        {steps.length === 0 && <li className="px-3 py-2 text-sm text-neutral-500">No tool calls in this prompt</li>}
        {steps.map((s) => (
          <Step key={s.order} step={s} />
        ))}
        <li className="flex items-center gap-2 px-3 py-2 text-sm text-neutral-300">
          <Bot size={14} className="text-neutral-400" />
          final response
          <span className="ml-auto text-xs text-neutral-500">
            {formatTokenCount(prompt.output_tokens ?? 0)} output tokens
          </span>
        </li>
      </ol>
    </section>
  )
}
