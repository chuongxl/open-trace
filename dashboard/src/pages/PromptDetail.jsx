import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { getPrompt, getSession } from '../api/client.js'
import AgentTrace from '../components/AgentTrace.jsx'
import Breadcrumb from '../components/Breadcrumb.jsx'
import CostBadge from '../components/CostBadge.jsx'
import LoadingSkeleton from '../components/LoadingSkeleton.jsx'
import { formatTokenCount, shortenHomePath } from '../lib/format.js'

export default function PromptDetail() {
  const { id } = useParams()
  const [state, setState] = useState({})

  useEffect(() => {
    let cancelled = false
    getPrompt(id)
      .then(async (prompt) => {
        // The session supplies the breadcrumb; the page still works without it.
        const session = await getSession(prompt.session_id).catch(() => null)
        if (!cancelled) setState({ id, prompt, session })
      })
      .catch((error) => !cancelled && setState({ id, error }))
    return () => {
      cancelled = true
    }
  }, [id])

  if (state.id !== id) return <LoadingSkeleton />
  if (state.error) return <p className="text-sm text-red-400">{state.error.message}</p>

  const { prompt, session } = state
  const crumbs = [{ label: 'Projects', to: '/projects' }]
  if (session?.project_path) {
    crumbs.push({
      label: shortenHomePath(session.project_path),
      to: `/projects/${encodeURIComponent(session.project_path)}`,
    })
  }
  crumbs.push({ label: 'Session', to: `/sessions/${encodeURIComponent(prompt.session_id)}` }, { label: 'Prompt' })

  return (
    <div>
      <Breadcrumb items={crumbs} />
      <h1 className="text-xl font-semibold">Prompt</h1>
      <p className="mt-2 whitespace-pre-wrap rounded border border-neutral-800 bg-neutral-900 p-3 text-sm text-neutral-200">
        {prompt.input_text || '(no prompt text captured)'}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-neutral-400">
        <span>{prompt.model}</span>
        <span>{new Date(prompt.timestamp).toLocaleString()}</span>
        <span>{formatTokenCount(prompt.input_tokens)} in</span>
        <span>{formatTokenCount(prompt.output_tokens)} out</span>
        <CostBadge cost={prompt.equiv_cost_usd ?? 0} />
      </div>
      <div className="mt-6">
        <AgentTrace prompt={prompt} toolCalls={prompt.tool_calls} />
      </div>
    </div>
  )
}
