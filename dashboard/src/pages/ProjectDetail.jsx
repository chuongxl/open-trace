import { useParams } from 'react-router-dom'

export default function ProjectDetail() {
  const { path } = useParams()
  return (
    <div>
      <h1 className="text-xl font-semibold">Project: {path}</h1>
      <p className="mt-2 text-sm text-neutral-400">No data yet.</p>
    </div>
  )
}
