export default function LoadingSkeleton() {
  return (
    <div className="animate-pulse space-y-3">
      <div className="h-6 w-40 rounded bg-neutral-800" />
      <div className="h-4 w-full rounded bg-neutral-800" />
      <div className="h-4 w-3/4 rounded bg-neutral-800" />
    </div>
  )
}
