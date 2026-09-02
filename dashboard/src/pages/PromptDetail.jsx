import { useParams } from 'react-router-dom'

export default function PromptDetail() {
  const { id } = useParams()
  return (
    <div>
      <h1 className="text-xl font-semibold">Prompt: {id}</h1>
      <p className="mt-2 text-sm text-neutral-400">No data yet.</p>
    </div>
  )
}
