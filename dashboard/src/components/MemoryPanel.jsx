import Markdown from './Markdown.jsx'
import { shortenHomePath } from '../lib/format.js'

export default function MemoryPanel({ files }) {
  if (files.length === 0) {
    return (
      <p className="mt-2 text-sm text-neutral-400">
        No memory files found (CLAUDE.md, .claude/memory.md, ~/.claude/CLAUDE.md)
      </p>
    )
  }
  return (
    <div className="mt-2 space-y-4">
      {files.map((f) => (
        <article key={f.path} className="rounded border border-neutral-800 bg-neutral-900">
          <header className="border-b border-neutral-800 px-4 py-2">
            <div className="text-sm font-medium text-neutral-200">{f.display}</div>
            <div className="truncate text-xs text-neutral-500" title={f.path}>
              {shortenHomePath(f.path)}
            </div>
          </header>
          <div className="px-4 py-3">
            {f.content.trim() ? <Markdown>{f.content}</Markdown> : <p className="text-sm italic text-neutral-500">(empty file)</p>}
          </div>
          <footer className="border-t border-neutral-800 px-4 py-2 text-xs text-neutral-500">
            {f.content.length.toLocaleString()} chars · modified {new Date(f.modified_at).toLocaleString()}
          </footer>
        </article>
      ))}
    </div>
  )
}
