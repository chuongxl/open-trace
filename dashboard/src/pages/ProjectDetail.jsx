import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { getSessions, getSessionMemory } from '../api/client.js'
import Breadcrumb from '../components/Breadcrumb.jsx'
import CostBadge from '../components/CostBadge.jsx'
import LoadingSkeleton from '../components/LoadingSkeleton.jsx'
import MemoryPanel from '../components/MemoryPanel.jsx'
import ToolBadge from '../components/ToolBadge.jsx'
import { formatTokenCount, shortenHomePath } from '../lib/format.js'

// `path` is the URL-decoded project_path (React Router decodes the param).
export default function ProjectDetail() {
  const { path } = useParams()
  const [state, setState] = useState({})
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = searchParams.get('tab') === 'memory' ? 'memory' : 'sessions'

  useEffect(() => {
    let cancelled = false
    getSessions({ project: path, limit: 200 })
      .then(async (sessions) => {
        // Memory is read per session; the most recent one (sessions come newest first) is current.
        const memory = sessions.length ? await getSessionMemory(sessions[0].id).catch(() => null) : null
        if (!cancelled) setState({ path, sessions, files: memory?.files ?? [] })
      })
      .catch((error) => !cancelled && setState({ path, error }))
    return () => {
      cancelled = true
    }
  }, [path])

  return (
    <div>
      <Breadcrumb items={[{ label: 'Projects', to: '/projects' }, { label: shortenHomePath(path) }]} />
      <h1 className="text-xl font-semibold" title={path}>
        {shortenHomePath(path)}
      </h1>
      <div className="mt-4 flex gap-1 border-b border-neutral-800" role="tablist">
        <TabButton active={tab === 'sessions'} onClick={() => setSearchParams({})}>
          Sessions
        </TabButton>
        <TabButton active={tab === 'memory'} onClick={() => setSearchParams({ tab: 'memory' })}>
          Memory
          {state.path === path && state.files?.length > 0 && (
            <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-sky-400" title="Memory files found" />
          )}
        </TabButton>
      </div>

      {state.path !== path && <LoadingSkeleton />}
      {state.path === path && state.error && <p className="mt-2 text-sm text-red-400">{state.error.message}</p>}
      {state.path === path && tab === 'memory' && state.files && <MemoryPanel files={state.files} />}
      {state.path === path && tab === 'sessions' && state.sessions && state.sessions.length === 0 && (
        <p className="mt-2 text-sm text-neutral-400">No sessions for this project</p>
      )}
      {state.path === path && tab === 'sessions' && state.sessions && state.sessions.length > 0 && (
        <ul className="mt-2 divide-y divide-neutral-800 rounded border border-neutral-800 bg-neutral-900">
          {state.sessions.map((s) => (
            <li key={s.id}>
              <Link
                to={`/sessions/${encodeURIComponent(s.id)}`}
                className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm hover:bg-neutral-800/60"
              >
                <ToolBadge tool={s.tool} />
                <span className="text-neutral-200">{new Date(s.started_at).toLocaleString()}</span>
                <span className="text-xs text-neutral-500">{s.model}</span>
                <span className="ml-auto text-xs text-neutral-400">
                  {formatTokenCount(s.total_input_tokens + s.total_output_tokens)} tokens
                </span>
                <CostBadge cost={s.equiv_cost_usd ?? 0} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function TabButton({ active, onClick, children }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`-mb-px border-b-2 px-3 py-2 text-sm ${
        active ? 'border-sky-400 text-white' : 'border-transparent text-neutral-400 hover:text-neutral-200'
      }`}
    >
      {children}
    </button>
  )
}
