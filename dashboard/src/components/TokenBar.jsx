import { tokenProportions } from '../lib/format.js'

export default function TokenBar({ input, output, cache }) {
  const { inputPct, outputPct, cachePct } = tokenProportions({ input, output, cache })
  return (
    <div
      className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-neutral-800"
      title={`input ${input} / output ${output} / cache ${cache}`}
    >
      <div className="bg-sky-500" style={{ width: `${inputPct}%` }} />
      <div className="bg-emerald-500" style={{ width: `${outputPct}%` }} />
      <div className="bg-amber-500" style={{ width: `${cachePct}%` }} />
    </div>
  )
}
