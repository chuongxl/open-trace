import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getSession, getSessionContext, subscribeLive } from '../api/client.js'
import Breadcrumb from '../components/Breadcrumb.jsx'
import LoadingSkeleton from '../components/LoadingSkeleton.jsx'
import { SECTIONS, barSegments, describeDelta, estTokens } from '../lib/context.js'
import { formatTokenCount, shortenHomePath } from '../lib/format.js'

export default function SessionContext() {
  const { id } = useParams()
  const [state, setState] = useState({})
  const [live, setLive] = useState(false)

  useEffect(() => {
    let cancelled = false
    let timer
    const load = () =>
      Promise.all([getSession(id), getSessionContext(id)])
        .then(([session, ctx]) => !cancelled && setState({ id, session, turns: ctx.turns }))
        .catch((error) => !cancelled && setState({ id, error }))
    load()
    // Refetch (debounced) whenever this session finishes a turn.
    const unsubscribe = subscribeLive(
      (e) => {
        if (e.data.session_id !== id || e.type === 'turn_started') return
        clearTimeout(timer)
        timer = setTimeout(() => load(), 300)
      },
      setLive,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
      unsubscribe()
    }
  }, [id])

  if (state.id !== id) return <LoadingSkeleton />
  if (state.error) return <p className="text-sm text-red-400">{state.error.message}</p>

  const { session, turns } = state
  const maxTotal = Math.max(0, ...turns.map((t) => t.total_chars))
  const crumbs = [{ label: 'Projects', to: '/projects' }]
  if (session.project_path) {
    crumbs.push({ label: shortenHomePath(session.project_path), to: `/projects/${encodeURIComponent(session.project_path)}` })
  }
  crumbs.push({ label: 'Session', to: `/sessions/${encodeURIComponent(id)}` }, { label: 'Context' })

  return (
    <div>
      <Breadcrumb items={crumbs} />
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Context inspector</h1>
        <span className={`inline-flex items-center gap-1.5 text-xs ${live ? 'text-emerald-400' : 'text-neutral-500'}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-emerald-400' : 'bg-neutral-600'}`} />
          {live ? 'live' : 'offline'}
        </span>
      </div>
      <p className="mt-1 text-xs text-neutral-400">
        What the model is sent on every request. Sizes are estimates (~chars/4), split by a heuristic: CLAUDE.md is detected from
        Claude Code’s injected reminder.
      </p>

      <div className="mt-3 flex flex-wrap gap-3 text-xs text-neutral-300">
        {SECTIONS.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-sm ${s.color}`} />
            {s.label}
          </span>
        ))}
      </div>

      {turns.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-400">
          No context data for this session. Only requests seen by the Claude Code proxy after this feature was added are measured.
        </p>
      ) : (
        <ol className="mt-4 space-y-3">
          {turns.map((t, i) => (
            <li key={t.prompt_id} className="rounded border border-neutral-800 bg-neutral-900 p-3">
              <div className="flex flex-wrap items-baseline gap-x-3 text-xs text-neutral-400">
                <span className="text-neutral-200">#{i + 1}</span>
                <span>{new Date(t.timestamp).toLocaleTimeString()}</span>
                <span title="estimated context size">~{formatTokenCount(estTokens(t.total_chars))} tokens in context</span>
                <span>{t.message_count} messages</span>
                {t.diff?.compacted && <span className="rounded bg-amber-900/50 px-1.5 text-amber-300">history compacted</span>}
                <Link to={`/prompts/${encodeURIComponent(t.prompt_id)}`} className="ml-auto text-sky-400 hover:underline">
                  trace
                </Link>
              </div>
              <div className="mt-2 flex h-3 overflow-hidden rounded bg-neutral-800" role="img" aria-label="context size by section">
                {barSegments(t.sections, maxTotal).map((s) => (
                  <div key={s.key} className={s.color} style={{ width: `${s.pct}%` }} title={`${s.label}: ~${formatTokenCount(s.tokens)} tokens`} />
                ))}
              </div>
              {t.diff && (
                <div className="mt-2 text-xs text-neutral-400">
                  <span className="text-neutral-300">{describeDelta(t.diff.delta, formatTokenCount) || 'no change'}</span>
                  {t.diff.added_messages > 0 && <span> · {t.diff.added_messages} new messages</span>}
                  {t.diff.largest_tool_result && (
                    <span>
                      {' '}
                      · largest new result: {t.diff.largest_tool_result.name ?? 'tool'} (~
                      {formatTokenCount(estTokens(t.diff.largest_tool_result.chars))} tokens)
                    </span>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
