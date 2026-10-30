import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getSession } from '../api/client.js'
import Breadcrumb from '../components/Breadcrumb.jsx'
import CostBadge from '../components/CostBadge.jsx'
import LoadingSkeleton from '../components/LoadingSkeleton.jsx'
import ToolBadge from '../components/ToolBadge.jsx'
import { formatTokenCount, shortenHomePath } from '../lib/format.js'

export default function SessionDetail() {
  const { id } = useParams()
  const [state, setState] = useState({})

  useEffect(() => {
    let cancelled = false
    getSession(id)
      .then((session) => !cancelled && setState({ id, session }))
      .catch((error) => !cancelled && setState({ id, error }))
    return () => {
      cancelled = true
    }
  }, [id])

  if (state.id !== id) return <LoadingSkeleton />
  if (state.error) return <p className="text-sm text-red-400">{state.error.message}</p>

  const { session } = state
  const crumbs = [{ label: 'Projects', to: '/projects' }]
  if (session.project_path) {
    crumbs.push({
      label: shortenHomePath(session.project_path),
      to: `/projects/${encodeURIComponent(session.project_path)}`,
    })
  }
  crumbs.push({ label: 'Session' })

  return (
    <div>
      <Breadcrumb items={crumbs} />
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{session.project_name || 'Session'}</h1>
        <ToolBadge tool={session.tool} />
        <CostBadge cost={session.equiv_cost_usd ?? 0} />
      </div>
      <div className="mt-1 text-xs text-neutral-400">
        {session.model} · started {new Date(session.started_at).toLocaleString()} ·{' '}
        {formatTokenCount(session.total_input_tokens)} in / {formatTokenCount(session.total_output_tokens)} out
      </div>

      {session.prompts.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-400">No prompts recorded for this session</p>
      ) : (
        <table className="mt-4 w-full text-left text-sm">
          <thead className="text-xs uppercase text-neutral-500">
            <tr>
              <th className="py-2 pr-3 font-medium">Time</th>
              <th className="py-2 pr-3 font-medium">Prompt</th>
              <th className="py-2 pr-3 font-medium">Tokens in / out</th>
              <th className="py-2 pr-3 font-medium">Tools</th>
              <th className="py-2 font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {session.prompts.map((p) => (
              <tr key={p.id} className="border-t border-neutral-800 hover:bg-neutral-800/40">
                <td className="whitespace-nowrap py-2 pr-3 text-neutral-400">{new Date(p.timestamp).toLocaleTimeString()}</td>
                <td className="max-w-md py-2 pr-3">
                  <Link to={`/prompts/${encodeURIComponent(p.id)}`} className="block truncate text-sky-400 hover:underline">
                    {p.input_text || '(no prompt text)'}
                  </Link>
                </td>
                <td className="whitespace-nowrap py-2 pr-3 text-neutral-300">
                  {formatTokenCount(p.input_tokens)} / {formatTokenCount(p.output_tokens)}
                </td>
                <td className="py-2 pr-3 text-neutral-300">{p.tool_call_count}</td>
                <td className="py-2">
                  <CostBadge cost={p.equiv_cost_usd ?? 0} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
