import { useEffect, useState } from 'react'
import { Pause, Play, SkipForward, Square } from 'lucide-react'
import { debugAction, getDebugState, setBreakOnAlert, subscribeLive } from '../api/client.js'
import { STATE_LABEL, availableActions } from '../lib/debug.js'

const BADGE = {
  running: 'bg-emerald-900/50 text-emerald-300',
  pausing: 'bg-amber-900/50 text-amber-300',
  paused: 'bg-amber-900/50 text-amber-300',
  stopping: 'bg-rose-900/50 text-rose-300',
}

// Pause / Step / Continue / Stop for a Claude Code session, kept in sync through the live feed.
export default function DebugControls({ sessionId }) {
  const [debug, setDebug] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    getDebugState(sessionId).then((d) => !cancelled && setDebug(d)).catch((e) => !cancelled && setError(e))
    const unsubscribe = subscribeLive((e) => {
      if (e.type !== 'debug_state' || e.data.session_id !== sessionId) return
      setDebug(e.data)
      // Auto-pause from an alert is the one case the engineer did not just ask for: tell them.
      if (e.data.reason === 'alert' && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('open-trace: session will pause', { body: 'A stuck-agent alert fired; the next request is held.' })
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [sessionId])

  if (error) return <p className="text-xs text-red-400">{error.message}</p>
  if (!debug) return null

  const can = availableActions(debug.state, debug.held.length)
  const run = (action) => debugAction(sessionId, action).then(setDebug).catch(setError)
  const toggleBreak = (enabled) => {
    if (enabled && typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission()
    setBreakOnAlert(sessionId, enabled).then(setDebug).catch(setError)
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 rounded border border-neutral-800 bg-neutral-900 px-3 py-2" role="group" aria-label="session debugger">
      <span className={`rounded px-2 py-0.5 text-xs ${BADGE[debug.state]}`}>{STATE_LABEL[debug.state]}</span>
      <div className="flex gap-1">
        <Btn icon={Pause} label="Pause" disabled={!can.pause} onClick={() => run('pause')} />
        <Btn icon={SkipForward} label="Step" disabled={!can.step} onClick={() => run('step')} />
        <Btn icon={Play} label="Continue" disabled={!can.continue} onClick={() => run('continue')} />
        <Btn icon={Square} label="Stop" disabled={!can.stop} onClick={() => run('stop')} danger />
      </div>
      {debug.held.length > 0 && (
        <span className="text-xs text-neutral-400">
          {debug.held.length} request{debug.held.length > 1 ? 's' : ''} held, {debug.held[0].message_count} messages in context
        </span>
      )}
      <label className="ml-auto flex items-center gap-1.5 text-xs text-neutral-400">
        <input type="checkbox" checked={debug.break_on_alert} onChange={(e) => toggleBreak(e.target.checked)} />
        Pause when an alert fires
      </label>
    </div>
  )
}

function Btn({ icon: Icon, label, disabled, onClick, danger }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${
        danger ? 'border-rose-800 text-rose-300 hover:bg-rose-950/50' : 'border-neutral-700 text-neutral-200 hover:bg-neutral-800'
      }`}
    >
      <Icon size={12} />
      {label}
    </button>
  )
}
