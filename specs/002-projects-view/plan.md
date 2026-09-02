# Projects View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `Projects.jsx` placeholder with a real, auto-refreshing project list — cards
with tool badge, token bar, cost badge, session count, and last-active — backed by an extended
`GET /api/projects`.

**Architecture:** One additive SQL change on the backend (`daemon/db/store.js`) adds the
input/output/cache token breakdown `GET /api/projects` was missing. On the frontend, pure
formatting/math logic lives in a new `dashboard/src/lib/format.js` module (unit-tested with
`node:test`, no new dependency), consumed by three small presentational components and the
`Projects.jsx` page, which owns fetching, the 30s auto-refresh, and client-side tool filtering.

**Tech Stack:** Node.js/Express/better-sqlite3 (daemon), React 19 + Tailwind v4 + react-router-dom
v7 (dashboard), `node:test` + `node:assert/strict` for all tests (already the repo's only test
tooling — see `tests/api.test.mjs`).

**Spec:** `specs/002-projects-view/spec.md`

## Global Constraints

- ESM only, Node >= 18 (repo-wide convention, `CLAUDE.md`).
- Costs are labeled "equiv. cost" only, never "cost" (repo-wide convention, `CLAUDE.md`) — already
  satisfied by `total_equiv_cost` naming; the new UI must not relabel it.
- `GET /api/projects` change is additive only — no existing field renamed or removed (spec API
  Contract Change section).
- No new npm dependency for testing — reuse `node:test` (spec Testing section).
- Tailwind v4 utility classes matching the existing dark theme (see `dashboard/src/components/
  Sidebar.jsx`, `dashboard/src/components/DaemonGate.jsx` for the established palette:
  `neutral-900`/`neutral-800`/`neutral-950` surfaces, `neutral-100`/`neutral-400` text).

---

### Task 1: Extend `GET /api/projects` with token breakdown

**Workspace:** root/backend (`daemon/`, `tests/`)

**Files:**
- Modify: `daemon/db/store.js:97-112` (`getProjects` function)
- Modify: `tests/api.test.mjs:80-89` (existing `GET /api/projects` test)

**Interfaces:**
- Consumes: nothing new — `getDb()` already imported in `store.js`.
- Produces: `getProjects()` rows now include `input_tokens`, `output_tokens`, `cache_read`,
  `cache_write` (numbers) alongside the existing `project_path`, `project_name`, `tool`,
  `session_count`, `total_tokens`, `total_equiv_cost`, `last_active`. Task 6 (`Projects.jsx`) reads
  these four new fields directly off each row.

- [ ] **Step 1: Write the failing assertions**

Edit `tests/api.test.mjs`, replacing the existing test body (lines 80-89) with:

```js
test('GET /api/projects lists projects with session counts and totals', async () => {
  const rows = await getJson('/api/projects');
  assert.ok(rows.length >= 2, 'expected proj-a and proj-b, got ' + rows.length);
  const a = rows.find(r => r.project_path.endsWith('proj-a'));
  assert.ok(a, 'proj-a missing: ' + JSON.stringify(rows));
  assert.equal(a.session_count, 1);
  assert.equal(a.total_tokens, 1500);
  assert.equal(Number(a.total_equiv_cost), 0.15);
  assert.ok(a.last_active, 'last_active present');
  assert.equal(a.input_tokens, 1000, 'input_tokens breakdown');
  assert.equal(a.output_tokens, 500, 'output_tokens breakdown');
  assert.equal(a.cache_read, 100, 'cache_read breakdown');
  assert.equal(a.cache_write, 50, 'cache_write breakdown');
});
```

(The `before()` block already seeds `sess-a` with `total_input_tokens: 1000,
total_output_tokens: 500, total_cache_read: 100, total_cache_write: 50` — no seed changes needed.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test` (from repo root)
Expected: FAIL on the four new `assert.equal` lines — `a.input_tokens` etc. are `undefined`.

- [ ] **Step 3: Implement the minimal SQL change**

Edit `daemon/db/store.js`, replacing lines 97-112 with:

```js
export function getProjects() {
  return getDb().prepare(`
    SELECT
      project_path,
      project_name,
      tool,
      COUNT(*)                                     AS session_count,
      SUM(total_input_tokens + total_output_tokens) AS total_tokens,
      SUM(total_input_tokens)                       AS input_tokens,
      SUM(total_output_tokens)                      AS output_tokens,
      SUM(total_cache_read)                         AS cache_read,
      SUM(total_cache_write)                        AS cache_write,
      SUM(equiv_cost_usd)                           AS total_equiv_cost,
      MAX(started_at)                               AS last_active
    FROM sessions
    WHERE project_path IS NOT NULL
    GROUP BY project_path, tool
    ORDER BY last_active DESC
  `).all();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test` (from repo root)
Expected: PASS, all assertions including the four new ones.

- [ ] **Step 5: Commit**

```bash
git add daemon/db/store.js tests/api.test.mjs
git commit -m "feat(api): add token breakdown to GET /api/projects"
```

---

### Task 2: `dashboard/src/lib/format.js` pure utilities + tests

**Workspace:** root/frontend (`dashboard/`)

**Files:**
- Create: `dashboard/src/lib/format.js`
- Create: `dashboard/src/lib/format.test.mjs`
- Modify: `dashboard/package.json:6-11` (add a `test` script)

**Interfaces:**
- Consumes: nothing (pure functions, no imports beyond none needed).
- Produces (consumed by Tasks 3-6): `shortenHomePath(path: string): string`,
  `costTier(cost: number): 'green' | 'yellow' | 'red'`,
  `formatTokenCount(n: number): string`,
  `tokenProportions({ input, output, cache }: { input?: number, output?: number, cache?: number }):
  { inputPct: number, outputPct: number, cachePct: number }`.

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/lib/format.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shortenHomePath, costTier, formatTokenCount, tokenProportions } from './format.js'

test('shortenHomePath replaces a leading home directory with ~', () => {
  assert.equal(shortenHomePath('/Users/chuong/github-me/open-trace'), '~/github-me/open-trace')
  assert.equal(shortenHomePath('/home/alice/proj'), '~/proj')
  assert.equal(shortenHomePath('/var/data/proj'), '/var/data/proj')
  assert.equal(shortenHomePath(''), '')
})

test('costTier buckets cost into green/yellow/red', () => {
  assert.equal(costTier(0), 'green')
  assert.equal(costTier(0.99), 'green')
  assert.equal(costTier(1), 'yellow')
  assert.equal(costTier(9.99), 'yellow')
  assert.equal(costTier(10), 'red')
  assert.equal(costTier(42), 'red')
})

test('formatTokenCount abbreviates large numbers', () => {
  assert.equal(formatTokenCount(500), '500')
  assert.equal(formatTokenCount(1500), '1.5k')
  assert.equal(formatTokenCount(1000), '1k')
  assert.equal(formatTokenCount(2500000), '2.5m')
})

test('tokenProportions computes percentages and handles zero total', () => {
  assert.deepEqual(tokenProportions({ input: 50, output: 30, cache: 20 }), {
    inputPct: 50, outputPct: 30, cachePct: 20,
  })
  assert.deepEqual(tokenProportions({ input: 0, output: 0, cache: 0 }), {
    inputPct: 0, outputPct: 0, cachePct: 0,
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && node --test src/lib/format.test.mjs`
Expected: FAIL — `format.js` does not exist yet (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `dashboard/src/lib/format.js`:

```js
const HOME_PREFIX = /^\/(?:Users|home)\/[^/]+/

export function shortenHomePath(path) {
  if (typeof path !== 'string') return ''
  return path.replace(HOME_PREFIX, '~')
}

export function costTier(cost) {
  if (cost >= 10) return 'red'
  if (cost >= 1) return 'yellow'
  return 'green'
}

export function formatTokenCount(n) {
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

export function tokenProportions({ input = 0, output = 0, cache = 0 }) {
  const total = input + output + cache
  if (total <= 0) return { inputPct: 0, outputPct: 0, cachePct: 0 }
  return {
    inputPct: (input / total) * 100,
    outputPct: (output / total) * 100,
    cachePct: (cache / total) * 100,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && node --test src/lib/format.test.mjs`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Add the dashboard `test` script**

Edit `dashboard/package.json`, replacing the `scripts` block (lines 6-11) with:

```json
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "lint": "oxlint",
    "preview": "vite preview",
    "test": "node --test src/lib/format.test.mjs"
  },
```

Run: `cd dashboard && npm test`
Expected: PASS, same 4 tests, confirming the script wiring.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/lib/format.js dashboard/src/lib/format.test.mjs dashboard/package.json
git commit -m "feat(dashboard): add format/token pure utils with tests"
```

---

### Task 3: `ToolBadge.jsx` component

**Workspace:** root/frontend (`dashboard/`)

**Files:**
- Create: `dashboard/src/components/ToolBadge.jsx`

**Interfaces:**
- Consumes: nothing.
- Produces (consumed by Task 6): `export default function ToolBadge({ tool: string })` — renders
  a colored pill; unknown `tool` values fall back to a neutral pill showing the raw string (never
  crashes on an unmapped tool, e.g. before Copilot has real data flowing through it).

No automated test: this is a static lookup-table renderer with no branching logic beyond a single
`??` fallback — trivial per the repo's "no test for trivial one-liners" bar. Verified visually in
Task 7.

- [ ] **Step 1: Implement**

Create `dashboard/src/components/ToolBadge.jsx`:

```jsx
const TOOLS = {
  'claude-code': { label: 'Claude Code', className: 'bg-orange-900/60 text-orange-300' },
  opencode: { label: 'OpenCode', className: 'bg-sky-900/60 text-sky-300' },
  copilot: { label: 'Copilot', className: 'bg-purple-900/60 text-purple-300' },
}

export default function ToolBadge({ tool }) {
  const meta = TOOLS[tool] ?? { label: tool, className: 'bg-neutral-800 text-neutral-300' }
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${meta.className}`}>
      {meta.label}
    </span>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/components/ToolBadge.jsx
git commit -m "feat(dashboard): add ToolBadge component"
```

---

### Task 4: `CostBadge.jsx` component

**Workspace:** root/frontend (`dashboard/`)

**Files:**
- Create: `dashboard/src/components/CostBadge.jsx`

**Interfaces:**
- Consumes: `costTier` from `dashboard/src/lib/format.js` (Task 2).
- Produces (consumed by Task 6): `export default function CostBadge({ cost: number })`.

No automated test: the branching logic it depends on (`costTier`) is already covered in Task 2;
this component is a pure rendering wrapper around that tested function.

- [ ] **Step 1: Implement**

Create `dashboard/src/components/CostBadge.jsx`:

```jsx
import { costTier } from '../lib/format.js'

const COLORS = {
  green: 'bg-green-900/60 text-green-300',
  yellow: 'bg-yellow-900/60 text-yellow-300',
  red: 'bg-red-900/60 text-red-300',
}

export default function CostBadge({ cost }) {
  const tier = costTier(cost)
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${COLORS[tier]}`}>
      ${cost.toFixed(2)}
    </span>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/components/CostBadge.jsx
git commit -m "feat(dashboard): add CostBadge component"
```

---

### Task 5: `TokenBar.jsx` component

**Workspace:** root/frontend (`dashboard/`)

**Files:**
- Create: `dashboard/src/components/TokenBar.jsx`

**Interfaces:**
- Consumes: `tokenProportions` from `dashboard/src/lib/format.js` (Task 2).
- Produces (consumed by Task 6): `export default function TokenBar({ input: number, output:
  number, cache: number })`.

No automated test: the math (`tokenProportions`, including the zero-total edge case) is already
covered in Task 2; this component only maps the returned percentages to `style.width`.

- [ ] **Step 1: Implement**

Create `dashboard/src/components/TokenBar.jsx`:

```jsx
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
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/components/TokenBar.jsx
git commit -m "feat(dashboard): add TokenBar component"
```

---

### Task 6: `Projects.jsx` — fetch, auto-refresh, filter, render

**Workspace:** root/frontend (`dashboard/`)

**Files:**
- Modify: `dashboard/src/pages/Projects.jsx` (currently an 8-line placeholder, full rewrite)

**Interfaces:**
- Consumes: `getProjects` (`dashboard/src/api/client.js`, already exported, unchanged),
  `ToolBadge` (Task 3), `CostBadge` (Task 4), `TokenBar` (Task 5), `shortenHomePath` +
  `formatTokenCount` (Task 2), `Link` from `react-router-dom` (already a dependency).
- Produces: the routed `/projects` page — no other task consumes this file.

No automated test for this task: it is a stateful component (fetch + timer + DOM), and the spec's
Testing section scopes automated coverage to pure functions only for this bounded feature (see
"Explicitly Out of Scope" in `spec.md`). Verified manually in Task 7.

- [ ] **Step 1: Implement**

Replace the full contents of `dashboard/src/pages/Projects.jsx` with:

```jsx
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getProjects } from '../api/client.js'
import ToolBadge from '../components/ToolBadge.jsx'
import CostBadge from '../components/CostBadge.jsx'
import TokenBar from '../components/TokenBar.jsx'
import { shortenHomePath, formatTokenCount } from '../lib/format.js'

const FILTERS = ['all', 'claude-code', 'opencode', 'copilot']
const FILTER_LABELS = {
  all: 'All',
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  copilot: 'Copilot',
}

export default function Projects() {
  const [projects, setProjects] = useState([])
  const [filter, setFilter] = useState('all')

  useEffect(() => {
    let cancelled = false
    const fetchProjects = () => {
      getProjects()
        .then((rows) => {
          if (!cancelled) setProjects(rows)
        })
        .catch((err) => console.error('Failed to refresh projects:', err))
    }
    fetchProjects()
    const id = setInterval(fetchProjects, 30000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  const filtered = filter === 'all' ? projects : projects.filter((p) => p.tool === filter)

  return (
    <div>
      <h1 className="text-xl font-semibold">Projects</h1>

      <div className="mt-4 flex gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`rounded px-3 py-1 text-sm ${
              filter === f
                ? 'bg-neutral-700 text-white'
                : 'bg-neutral-900 text-neutral-400 hover:bg-neutral-800'
            }`}
          >
            {FILTER_LABELS[f]}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-400">No projects tracked yet</p>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((p) => (
            <div
              key={`${p.project_path}:${p.tool}`}
              className="rounded border border-neutral-800 bg-neutral-900 p-4"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="truncate text-sm font-medium" title={p.project_path}>
                  {shortenHomePath(p.project_path)}
                </span>
                <ToolBadge tool={p.tool} />
              </div>

              <TokenBar
                input={p.input_tokens ?? 0}
                output={p.output_tokens ?? 0}
                cache={(p.cache_read ?? 0) + (p.cache_write ?? 0)}
              />

              <div className="mt-2 flex items-center justify-between text-xs text-neutral-400">
                <span>{p.session_count} sessions</span>
                <span>{formatTokenCount(p.total_tokens)} tokens</span>
                <CostBadge cost={p.total_equiv_cost} />
              </div>

              <div className="mt-1 text-xs text-neutral-500">
                Last active: {p.last_active ? new Date(p.last_active).toLocaleString() : '—'}
              </div>

              <Link
                to={`/projects/${encodeURIComponent(p.project_path)}`}
                className="mt-3 inline-block text-sm text-sky-400 hover:underline"
              >
                View →
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Build check**

Run: `cd dashboard && npm run build`
Expected: exits 0, no bundler/JSX errors.

- [ ] **Step 3: Lint check**

Run: `cd dashboard && npm run lint`
Expected: exits 0, no oxlint findings (in particular no `react/rules-of-hooks` violation from the
`useEffect` above).

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/pages/Projects.jsx
git commit -m "feat(dashboard): wire Projects page to GET /api/projects with filter + auto-refresh"
```

---

### Task 7: End-to-end manual verification

**Workspace:** root (cross-cutting: `daemon/` + `dashboard/`)

**Files:** none (verification only, no code changes).

**Interfaces:** none — this task consumes the running system built by Tasks 1-6.

- [ ] **Step 1: Seed a temp DB with fixture projects**

Run (from repo root), adapted from the seeding pattern already used in `tests/api.test.mjs`:

```bash
node -e "
process.env.DB_PATH = '/tmp/open-trace-verify.db';
import('./daemon/db/store.js').then((store) => {
  const now = Date.now();
  store.upsertSession({ id: 'v1', tool: 'opencode', started_at: now - 3600000, project_path: '/Users/chuong/demo-proj', project_name: 'demo-proj', model: 'claude-haiku-4-5', total_input_tokens: 5000, total_output_tokens: 2000, total_cache_read: 800, total_cache_write: 200, equiv_cost_usd: 3.5 });
  store.upsertSession({ id: 'v2', tool: 'claude-code', started_at: now - 1800000, project_path: '/Users/chuong/other-proj', project_name: 'other-proj', model: 'claude-sonnet-4-5', total_input_tokens: 500, total_output_tokens: 200, total_cache_read: 0, total_cache_write: 0, equiv_cost_usd: 0.4 });
  console.log('seeded');
});
"
```

Expected: prints `seeded`, creates `/tmp/open-trace-verify.db`.

- [ ] **Step 2: Start the daemon against the seeded DB**

Run: `DB_PATH=/tmp/open-trace-verify.db DAEMON_PORT=9900 node daemon/index.js`
Expected: logs `[open-trace] Dashboard at http://localhost:9900`.

- [ ] **Step 3: Confirm the API shape via curl**

Run (new terminal): `curl -s http://localhost:9900/api/projects`
Expected: a JSON array where each row has `input_tokens`, `output_tokens`, `cache_read`,
`cache_write` populated with the seeded numbers (e.g. `demo-proj`: `input_tokens: 5000,
output_tokens: 2000, cache_read: 800, cache_write: 200`).

- [ ] **Step 4: Start the dashboard dev server and view it**

Run: `cd dashboard && npm run dev` (proxies `/api` to port 9900 per `vite.config.js`).
Open `http://localhost:5173/projects` in a browser (or use whatever screen-viewing tool is
available in the current environment — e.g. the `run` skill, if present).
Expected, visually:
- Two cards: `~/demo-proj` (OpenCode badge) and `~/other-proj` (Claude Code badge).
- Each card's token bar shows non-zero, proportionally-sized segments.
- `demo-proj`'s cost badge is red (`$3.50` ≥ $10 is false — recompute: $3.50 falls in the yellow
  band `[$1, $10)`, so expect **yellow**; `other-proj` at `$0.40` expects **green**.
- Clicking "OpenCode" filters the list to just `demo-proj`; clicking "All" restores both.
- Clicking "Copilot" shows the "No projects tracked yet" empty state (no Copilot data seeded).
- `[View →]` on `demo-proj` navigates to `/projects/%2FUsers%2Fchuong%2Fdemo-proj` and renders the
  existing `ProjectDetail.jsx` placeholder heading with the decoded path.

If no live-browser viewing tool is available in the execution environment, explicitly say so in
the completion report rather than claiming the visual check passed — the curl-level API check
(Step 3) and the build/lint checks (Task 6, Steps 2-3) still stand on their own as evidence.

- [ ] **Step 5: Clean up**

Stop the daemon (`Ctrl+C` / kill the process) and the dashboard dev server; remove the temp DB:

```bash
rm -f /tmp/open-trace-verify.db /tmp/open-trace-verify.db-wal /tmp/open-trace-verify.db-shm
```

No commit for this task (verification only).
