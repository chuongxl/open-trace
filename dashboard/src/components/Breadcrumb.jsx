import { Link } from 'react-router-dom'

// items: [{ label, to? }] — the last item is the current page and is not a link.
export default function Breadcrumb({ items }) {
  return (
    <nav className="mb-4 flex flex-wrap items-center gap-1 text-sm text-neutral-400" aria-label="Breadcrumb">
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <span aria-hidden="true">›</span>}
          {item.to ? (
            <Link to={item.to} className="text-sky-400 hover:underline">
              {item.label}
            </Link>
          ) : (
            <span className="text-neutral-200">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  )
}
