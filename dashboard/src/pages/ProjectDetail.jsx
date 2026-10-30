import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getSessions } from '../api/client.js'
import Breadcrumb from '../components/Breadcrumb.jsx'
import CostBadge from '../components/CostBadge.jsx'
import LoadingSkeleton from '../components/LoadingSkeleton.jsx'
import ToolBadge from '../components/ToolBadge.jsx'
import { formatTokenCount, shortenHomePath } from '../lib/format.js'

// `path` is the URL-decoded project_path (React Router decodes the param).
export default function ProjectDetail() {
  const { path } = useParams()
  const [state, setState] = useState({})

  useEffect(() => {
    let cancelled = false
    getSessions({ project: path, limit: 200 })
      .then((sessions) => !cancelled && setState({ path, sessions }))
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
      <h2 className="mt-4 text-sm font-medium text-neutral-300">Sessions</h2>

      {state.path !== path && <LoadingSkeleton />}
      {state.path === path && state.error && <p className="mt-2 text-sm text-red-400">{state.error.message}</p>}
      {state.path === path && state.sessions && state.sessions.length === 0 && (
        <p className="mt-2 text-sm text-neutral-400">No sessions for this project</p>
      )}
      {state.path === path && state.sessions && state.sessions.length > 0 && (
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
