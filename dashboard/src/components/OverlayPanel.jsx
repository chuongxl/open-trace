import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { addOverlayRule, getOverlay, previewOverlayRule, removeOverlayRule, setPassthrough, subscribeLive } from '../api/client.js'
import { describePreview, describeRule } from '../lib/overlay.js'

const money = (usd) => (usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`)

// Edit what the model is sent: inject guidance or trim tool results, applied to every request of this
// session. Preview needs a held request (pause the session first). Replace/delete are available via the API.
export default function OverlayPanel({ sessionId }) {
  const [data, setData] = useState(null)
  const [kind, setKind] = useState('append_user_message')
  const [text, setText] = useState('')
  const [maxChars, setMaxChars] = useState(2000)
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    const load = () => getOverlay(sessionId).then((d) => !cancelled && setData(d)).catch((e) => !cancelled && setError(e))
    load()
    const unsubscribe = subscribeLive((e) => {
      if ((e.type === 'overlay_changed' || e.type === 'overlay_applied') && (!e.data.session_id || e.data.session_id === sessionId)) load()
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [sessionId])

  if (!data) return error ? <p className="mt-3 text-xs text-red-400">{error.message}</p> : null

  const rule = kind === 'append_user_message' ? { kind, params: { text: text.trim() } } : { kind, params: { max_chars: Number(maxChars) } }
  const ready = kind === 'append_user_message' ? text.trim() !== '' : Number(maxChars) >= 0
  const fail = (e) => setError(e)
  const reload = () => getOverlay(sessionId).then(setData)

  return (
    <section className="mt-3 rounded border border-neutral-800 bg-neutral-900 p-3" aria-label="context overlay">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-medium text-neutral-200">Context overlay</h2>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-neutral-400">
          <input type="checkbox" checked={data.passthrough} onChange={(e) => setPassthrough(e.target.checked).then(reload).catch(fail)} />
          Pass-through (ignore all rules)
        </label>
      </div>
      <p className="mt-1 text-xs text-neutral-500">
        Changes are applied by open-trace to every request and will not appear in the Claude Code transcript.
      </p>

      {data.rules.length > 0 && (
        <ul className="mt-2 space-y-1">
          {data.rules.map((r) => (
            <li key={r.id} className="flex items-center gap-2 text-sm text-neutral-300">
              <span className={data.passthrough ? 'line-through opacity-50' : ''}>{describeRule(r)}</span>
              <button type="button" title="Remove rule" className="ml-auto text-neutral-500 hover:text-rose-400" onClick={() => removeOverlayRule(sessionId, r.id).then(reload).catch(fail)}>
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 space-y-2">
        <select value={kind} onChange={(e) => { setKind(e.target.value); setPreview(null) }} className="rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs">
          <option value="append_user_message">Inject guidance</option>
          <option value="truncate_tool_result">Trim tool results</option>
        </select>
        {kind === 'append_user_message' ? (
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setPreview(null) }}
            rows={2}
            placeholder="Guidance the model should see, e.g. “Don’t touch the migrations; fix it in the service layer.”"
            className="w-full rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-sm"
          />
        ) : (
          <label className="flex items-center gap-2 text-xs text-neutral-400">
            Keep at most
            <input type="number" min="0" value={maxChars} onChange={(e) => { setMaxChars(e.target.value); setPreview(null) }} className="w-24 rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-sm text-neutral-200" />
            characters of each tool result
          </label>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={!ready} className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800 disabled:opacity-40"
            onClick={() => { setError(null); previewOverlayRule(sessionId, rule).then(setPreview).catch(fail) }}>
            Preview
          </button>
          <button type="button" disabled={!ready} className="rounded border border-sky-700 px-2 py-1 text-xs text-sky-300 hover:bg-sky-950/50 disabled:opacity-40"
            onClick={() => { setError(null); addOverlayRule(sessionId, rule).then(() => { setText(''); setPreview(null); return reload() }).catch(fail) }}>
            Add rule
          </button>
          <span className="text-xs text-neutral-500">Preview needs a held request: pause the session first.</span>
        </div>
        {preview && <p className={`text-xs ${preview.valid ? 'text-emerald-300' : 'text-rose-300'}`}>{describePreview(preview, money)}</p>}
        {error && <p className="text-xs text-red-400">{error.message}</p>}
      </div>

      {data.audit.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-neutral-400">Audit trail ({data.audit.length})</summary>
          <ul className="mt-1 max-h-48 space-y-0.5 overflow-auto text-xs text-neutral-400">
            {data.audit.map((a) => (
              <li key={a.id}>
                <span className="text-neutral-500">{new Date(a.created_at).toLocaleTimeString()}</span> <span className="text-neutral-300">{a.action}</span>
                {a.detail && <> — {a.detail}</>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
