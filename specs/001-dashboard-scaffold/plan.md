# Dashboard Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold `dashboard/` — a Vite + React 19 + Tailwind v4 SPA with dark styling, five routed
placeholder pages, an API client wrapping all 9 daemon endpoints, and a daemon-health error
boundary — satisfying issue #8's acceptance criteria.

**Architecture:** Standard Vite React app. `BrowserRouter`/`Routes` (declarative, no data-router
loaders) renders one of five placeholder pages inside a `DaemonGate` wrapper that pings
`GET /api/health` before showing content. `src/api/client.js` exports one fetch wrapper per
endpoint in `daemon/api/router.js`; only `getHealth` is consumed in this plan.

**Tech Stack:** Vite 6, React 19, TailwindCSS v4 (`@tailwindcss/vite`, CSS-first config),
react-router-dom v7, recharts 2.x (installed, unused), lucide-react, `@mlc-ai/web-llm` (installed,
unused).

**Spec:** `specs/001-dashboard-scaffold/spec.md`

## Global Constraints

- ESM only, Node >= 18 (repo-wide, `CLAUDE.md`).
- Scaffold-only scope: pages are placeholders (title + "No data yet."); the only live API call in
  this plan is `DaemonGate`'s `getHealth()`. Real data wiring is out of scope (issues #9/#10/#11).
- No test framework is added to `dashboard/`. Verification = `npm run build` (must exit 0) plus
  `node scripts/check-client-exports.mjs` (must exit 0).
- Dev proxy target is the daemon's dev port, `9900` (`CLAUDE.md`: "npm run dev (daemon at port
  9900)").
- Dark styling is unconditional — no light/dark toggle, no `dark:` variant machinery.
- `src/api/client.js` must wrap the 9 endpoints in `daemon/api/router.js` 1:1, including exact
  query params and body shape (`postOptimization` takes one `body` object containing `prompt_id`,
  not a separate `promptId` argument — the router reads `prompt_id` from the JSON body).

---

### Task 1: Vite + React + Tailwind v4 scaffold, dev proxy

**Workspace:** `.`

**Files:**
- Create: `dashboard/` (via `npm create vite@latest`)
- Modify: `dashboard/package.json` (add deps)
- Create: `dashboard/vite.config.js`
- Create: `dashboard/src/index.css`
- Modify: `dashboard/index.html`
- Modify: `dashboard/src/main.jsx`
- Modify: `dashboard/src/App.jsx` (placeholder — replaced in Task 3)
- Delete: `dashboard/src/App.css`, `dashboard/src/assets/react.svg`, `dashboard/public/vite.svg`
  (default template cruft, unused)

**Interfaces:**
- Produces: a Vite dev server proxying `/api/*` → `http://localhost:9900`; `npm run build` in
  `dashboard/` producing `dashboard/dist/`.

- [ ] **Step 1: Scaffold the Vite project**

From the repo root:

```bash
npm create vite@latest dashboard -- --template react
```

- [ ] **Step 2: Install base + feature dependencies**

```bash
cd dashboard
npm install
npm install react-router-dom@^7 recharts@^2 lucide-react @mlc-ai/web-llm
npm install -D tailwindcss@^4 @tailwindcss/vite
```

- [ ] **Step 3: Remove template cruft**

```bash
rm -f src/App.css src/assets/react.svg public/vite.svg
```

- [ ] **Step 4: Write `vite.config.js`**

```javascript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:9900',
        changeOrigin: true,
      },
    },
  },
})
```

- [ ] **Step 5: Write `src/index.css`**

```css
@import "tailwindcss";

body {
  margin: 0;
  background-color: #171717;
  color: #f5f5f5;
  font-family: system-ui, -apple-system, sans-serif;
}
```

- [ ] **Step 6: Update `index.html` title**

Open `index.html`, change the `<title>` element to:

```html
<title>open-trace</title>
```

- [ ] **Step 7: Write `src/main.jsx`**

```jsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 8: Write a placeholder `src/App.jsx`**

(Replaced with real routing in Task 3 — this only proves the build pipeline works.)

```jsx
export default function App() {
  return <div className="p-6 text-neutral-100">Dashboard loading…</div>
}
```

- [ ] **Step 9: Verify the build**

```bash
npm run build
```

Expected: exits 0, creates `dashboard/dist/index.html`.

- [ ] **Step 10: Commit**

```bash
cd ..
git add dashboard
git commit -m "feat(dashboard): scaffold Vite + React + Tailwind v4, dev proxy"
```

---

### Task 2: API client + export-check script

**Workspace:** `.`

**Files:**
- Create: `dashboard/src/api/client.js`
- Create: `dashboard/scripts/check-client-exports.mjs`

**Interfaces:**
- Produces: `client.js` exporting `getHealth`, `getOverview(days)`, `getProjects()`,
  `getSessions({tool, project, limit, offset})`, `getSession(id)`, `getSessionMemory(id)`,
  `getPrompt(id)`, `postOptimization(body)`, `getOptimization(promptId)` — each an `async function`
  returning parsed JSON, thrown `Error` on non-2xx.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Write `src/api/client.js`**

```javascript
const BASE = '/api'

async function request(path, options) {
  const res = await fetch(`${BASE}${path}`, options)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Request failed: ${res.status}`)
  }
  return res.json()
}

export function getHealth() {
  return request('/health')
}

export function getOverview(days = 30) {
  return request(`/overview?days=${encodeURIComponent(days)}`)
}

export function getProjects() {
  return request('/projects')
}

export function getSessions({ tool, project, limit = 50, offset = 0 } = {}) {
  const params = new URLSearchParams()
  if (tool) params.set('tool', tool)
  if (project) params.set('project', project)
  params.set('limit', limit)
  params.set('offset', offset)
  return request(`/sessions?${params.toString()}`)
}

export function getSession(id) {
  return request(`/sessions/${encodeURIComponent(id)}`)
}

export function getSessionMemory(id) {
  return request(`/sessions/${encodeURIComponent(id)}/memory`)
}

export function getPrompt(id) {
  return request(`/prompts/${encodeURIComponent(id)}`)
}

export function postOptimization(body) {
  return request('/optimizations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function getOptimization(promptId) {
  return request(`/optimizations/${encodeURIComponent(promptId)}`)
}
```

- [ ] **Step 2: Write `scripts/check-client-exports.mjs`**

```javascript
import * as client from '../src/api/client.js'

const expected = [
  'getHealth', 'getOverview', 'getProjects', 'getSessions', 'getSession',
  'getSessionMemory', 'getPrompt', 'postOptimization', 'getOptimization',
]

const missing = expected.filter((name) => typeof client[name] !== 'function')

if (missing.length > 0) {
  console.error(`Missing or non-function exports from api/client.js: ${missing.join(', ')}`)
  process.exit(1)
}

console.log(`OK: all ${expected.length} client exports present.`)
```

- [ ] **Step 3: Run the check script**

```bash
cd dashboard
node scripts/check-client-exports.mjs
```

Expected: `OK: all 9 client exports present.`

- [ ] **Step 4: Commit**

```bash
cd ..
git add dashboard/src/api/client.js dashboard/scripts/check-client-exports.mjs
git commit -m "feat(dashboard): API client wrapping all 9 daemon endpoints"
```

---

### Task 3: Routing, sidebar, placeholder pages

**Workspace:** `.`

**Files:**
- Modify: `dashboard/src/App.jsx`
- Create: `dashboard/src/components/Sidebar.jsx`
- Create: `dashboard/src/pages/Overview.jsx`
- Create: `dashboard/src/pages/Projects.jsx`
- Create: `dashboard/src/pages/ProjectDetail.jsx`
- Create: `dashboard/src/pages/SessionDetail.jsx`
- Create: `dashboard/src/pages/PromptDetail.jsx`

**Interfaces:**
- Consumes: none (pages are static; no `client.js` calls here per scope decision).
- Produces: `App.jsx` default export rendering `BrowserRouter` + `Sidebar` + the 5 routes below;
  `Sidebar` default export (no props); each page component default export taking no props (route
  params read via `useParams()` where needed).

- [ ] **Step 1: Write `src/pages/Overview.jsx`**

```jsx
export default function Overview() {
  return (
    <div>
      <h1 className="text-xl font-semibold">Overview</h1>
      <p className="mt-2 text-sm text-neutral-400">No data yet.</p>
    </div>
  )
}
```

- [ ] **Step 2: Write `src/pages/Projects.jsx`**

```jsx
export default function Projects() {
  return (
    <div>
      <h1 className="text-xl font-semibold">Projects</h1>
      <p className="mt-2 text-sm text-neutral-400">No data yet.</p>
    </div>
  )
}
```

- [ ] **Step 3: Write `src/pages/ProjectDetail.jsx`**

```jsx
import { useParams } from 'react-router-dom'

export default function ProjectDetail() {
  const { path } = useParams()
  return (
    <div>
      <h1 className="text-xl font-semibold">Project: {decodeURIComponent(path)}</h1>
      <p className="mt-2 text-sm text-neutral-400">No data yet.</p>
    </div>
  )
}
```

- [ ] **Step 4: Write `src/pages/SessionDetail.jsx`**

```jsx
import { useParams } from 'react-router-dom'

export default function SessionDetail() {
  const { id } = useParams()
  return (
    <div>
      <h1 className="text-xl font-semibold">Session: {id}</h1>
      <p className="mt-2 text-sm text-neutral-400">No data yet.</p>
    </div>
  )
}
```

- [ ] **Step 5: Write `src/pages/PromptDetail.jsx`**

```jsx
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
```

- [ ] **Step 6: Write `src/components/Sidebar.jsx`**

```jsx
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
```

- [ ] **Step 7: Replace `src/App.jsx` with routing**

```jsx
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Sidebar from './components/Sidebar.jsx'
import Overview from './pages/Overview.jsx'
import Projects from './pages/Projects.jsx'
import ProjectDetail from './pages/ProjectDetail.jsx'
import SessionDetail from './pages/SessionDetail.jsx'
import PromptDetail from './pages/PromptDetail.jsx'

export default function App() {
  return (
    <BrowserRouter>
      <div className="flex min-h-screen bg-neutral-900 text-neutral-100">
        <Sidebar />
        <main className="flex-1 p-6">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/:path" element={<ProjectDetail />} />
            <Route path="/sessions/:id" element={<SessionDetail />} />
            <Route path="/prompts/:id" element={<PromptDetail />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
```

- [ ] **Step 8: Verify the build**

```bash
cd dashboard
npm run build
```

Expected: exits 0.

- [ ] **Step 9: Commit**

```bash
cd ..
git add dashboard/src
git commit -m "feat(dashboard): routing, sidebar, placeholder pages for all 5 routes"
```

---

### Task 4: Loading skeleton, DaemonGate, full verification

**Workspace:** `.`

**Files:**
- Create: `dashboard/src/components/LoadingSkeleton.jsx`
- Create: `dashboard/src/components/DaemonGate.jsx`
- Modify: `dashboard/src/App.jsx:1-24` (wrap `<Routes>` in `<DaemonGate>`)

**Interfaces:**
- Consumes: `getHealth` from `dashboard/src/api/client.js` (Task 2).
- Produces: `DaemonGate` default export, prop `children`; renders `LoadingSkeleton` while pending,
  an error message on failure, `children` on success.

- [ ] **Step 1: Write `src/components/LoadingSkeleton.jsx`**

```jsx
export default function LoadingSkeleton() {
  return (
    <div className="animate-pulse space-y-3">
      <div className="h-6 w-40 rounded bg-neutral-800" />
      <div className="h-4 w-full rounded bg-neutral-800" />
      <div className="h-4 w-3/4 rounded bg-neutral-800" />
    </div>
  )
}
```

- [ ] **Step 2: Write `src/components/DaemonGate.jsx`**

```jsx
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
```

- [ ] **Step 3: Wire `DaemonGate` into `src/App.jsx`**

Replace the `<main>` block:

```jsx
import DaemonGate from './components/DaemonGate.jsx'
```

(add to the import block at the top), then change:

```jsx
        <main className="flex-1 p-6">
          <Routes>
```

to:

```jsx
        <main className="flex-1 p-6">
          <DaemonGate>
            <Routes>
```

and close it — the existing `</Routes>` becomes:

```jsx
            </Routes>
          </DaemonGate>
        </main>
```

- [ ] **Step 4: Verify the build**

```bash
cd dashboard
npm run build
```

Expected: exits 0.

- [ ] **Step 5: Verify client exports (regression check)**

```bash
node scripts/check-client-exports.mjs
```

Expected: `OK: all 9 client exports present.`

- [ ] **Step 6: Verify the dev proxy end-to-end against the real daemon**

From the repo root, in one terminal:

```bash
npm run dev
```

In a second terminal:

```bash
cd dashboard
npm run dev -- --port 5173 &
sleep 2
curl -s http://localhost:5173/api/health
curl -s http://localhost:5173/ | grep -o '<div id="root">'
kill %1
```

Expected: the health curl returns `{"status":"ok",...}` (proves the `/api` proxy reaches the
daemon on port 9900); the second curl finds `<div id="root">` (proves the dev server serves the
app shell). Stop the daemon (`Ctrl+C` in the first terminal) after this check.

- [ ] **Step 7: Commit**

```bash
cd ..
git add dashboard/src
git commit -m "feat(dashboard): loading skeleton + daemon-health error boundary"
```
