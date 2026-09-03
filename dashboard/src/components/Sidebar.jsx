import { NavLink } from 'react-router-dom'
import { LayoutDashboard, FolderKanban } from 'lucide-react'

const links = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/projects', label: 'Projects', icon: FolderKanban, end: false },
]

export default function Sidebar() {
  return (
    <nav className="w-56 shrink-0 border-r border-neutral-800 bg-neutral-950 p-4">
      <div className="mb-6 text-lg font-semibold">open-trace</div>
      <ul className="space-y-1">
        {links.map(({ to, label, icon: Icon, end }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded px-3 py-2 text-sm ${
                  isActive ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:bg-neutral-800/60'
                }`
              }
            >
              <Icon size={16} />
              {label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}
