import { useEffect, useState } from 'react'
import { getHealth } from '../api/client.js'
import LoadingSkeleton from './LoadingSkeleton.jsx'

export default function DaemonGate({ children }) {
  const [status, setStatus] = useState('pending') // 'pending' | 'ok' | 'down'

  useEffect(() => {
    let cancelled = false
    getHealth()
      .then(() => {
        if (!cancelled) setStatus('ok')
      })
      .catch(() => {
        if (!cancelled) setStatus('down')
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (status === 'pending') return <LoadingSkeleton />
  if (status === 'down') {
    return (
      <div className="rounded border border-red-900 bg-red-950/40 p-4 text-red-300">
        Daemon not running. Start it with <code className="font-mono">npm run dev</code> in the
        repo root, then reload.
      </div>
    )
  }
  return children
}
