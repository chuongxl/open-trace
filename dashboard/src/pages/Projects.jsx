import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getProjects } from '../api/client.js'
import ToolBadge from '../components/ToolBadge.jsx'
import CostBadge from '../components/CostBadge.jsx'
import TokenBar from '../components/TokenBar.jsx'
import { shortenHomePath, formatTokenCount } from '../lib/format.js'

const FILTERS = ['all', 'claude-code', 'opencode', 'copilot']
const FILTER_LABELS = {
  all: 'All',
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  copilot: 'Copilot',
}

export default function Projects() {
  const [projects, setProjects] = useState([])
  const [filter, setFilter] = useState('all')

  useEffect(() => {
    let cancelled = false
    const fetchProjects = () => {
      getProjects()
        .then((rows) => {
          if (!cancelled) setProjects(rows)
        })
        .catch((err) => console.error('Failed to refresh projects:', err))
    }
    fetchProjects()
    const id = setInterval(fetchProjects, 30000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  const filtered = filter === 'all' ? projects : projects.filter((p) => p.tool === filter)

  return (
    <div>
      <h1 className="text-xl font-semibold">Projects</h1>

      <div className="mt-4 flex gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`rounded px-3 py-1 text-sm ${
              filter === f
                ? 'bg-neutral-700 text-white'
                : 'bg-neutral-900 text-neutral-400 hover:bg-neutral-800'
            }`}
          >
            {FILTER_LABELS[f]}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-400">No projects tracked yet</p>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((p) => (
            <div
              key={`${p.project_path}:${p.tool}`}
              className="rounded border border-neutral-800 bg-neutral-900 p-4"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="truncate text-sm font-medium" title={p.project_path}>
                  {shortenHomePath(p.project_path)}
                </span>
                <ToolBadge tool={p.tool} />
              </div>

              <TokenBar
                input={p.input_tokens ?? 0}
                output={p.output_tokens ?? 0}
                cache={(p.cache_read ?? 0) + (p.cache_write ?? 0)}
              />

              <div className="mt-2 flex items-center justify-between text-xs text-neutral-400">
                <span>{p.session_count} sessions</span>
                <span>{formatTokenCount(p.total_tokens)} tokens</span>
                <CostBadge cost={p.total_equiv_cost} />
              </div>

              <div className="mt-1 text-xs text-neutral-500">
                Last active: {p.last_active ? new Date(p.last_active).toLocaleString() : '—'}
              </div>

              <Link
                to={`/projects/${encodeURIComponent(p.project_path)}`}
                className="mt-3 inline-block text-sm text-sky-400 hover:underline"
              >
                View →
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
