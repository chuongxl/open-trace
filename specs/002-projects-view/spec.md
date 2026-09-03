# Projects View (Phase 5)

**Source:** GitHub issue [#9](https://github.com/chuongxl/open-trace/issues/9) — `[Phase 5] Feature: Projects view — folder, session count, total tokens`
**Status:** completed
**Classification:** Bounded — a page + 3 small presentational components built on the already-scaffolded dashboard (`specs/001-dashboard-scaffold/`) and the already-implemented `GET /api/projects` endpoint (Phase 4).

## Overview

The engineer's home view: every tracked project (folder + tool) at a glance, with usage stats,
client-side tool filtering, and a 30s auto-refresh. Replaces the current `Projects.jsx` placeholder.

## Decisions (resolved during design)

1. **One card per (folder, tool) pair.** `GET /api/projects` returns one row per `(project_path,
   tool)` — a folder used with two tools produces two rows. The UI renders exactly that: no
   client-side merging. Each card has exactly one `ToolBadge`.
2. **`GET /api/projects` gains a token breakdown.** It currently returns only a combined
   `total_tokens`. `TokenBar` needs input/output/cache proportions, so `daemon/db/store.js
   getProjects()` adds `input_tokens`, `output_tokens`, `cache_read`, `cache_write` to its SQL
   aggregation — purely additive, no existing field changes shape or name.
3. **Tool filter includes Copilot now**, even though no Copilot watcher exists yet (selecting it
   just yields the empty state today) — matches the issue's filter list verbatim and needs no
   extra code path.

## API Contract Change

`GET /api/projects` response row, before → after:

```
// before
{ project_path, project_name, tool, session_count, total_tokens, total_equiv_cost, last_active }

// after (additive)
{ project_path, project_name, tool, session_count, total_tokens, total_equiv_cost, last_active,
  input_tokens, output_tokens, cache_read, cache_write }
```

`daemon/api/router.js` needs no change — it already passes `store.getProjects()` straight through.

## Components

- **`pages/Projects.jsx`** — fetches `getProjects()` on mount + every 30s (`setInterval`, cleared
  on unmount); holds `{ tool: 'all'|'claude-code'|'opencode'|'copilot' }` filter state, applied
  client-side to the already-fetched array (no refetch on filter change); renders one card per
  row; `[View →]` navigates to `/projects/${encodeURIComponent(project_path)}`; empty state "No
  projects tracked yet" whenever the *filtered* list is empty (covers both "nothing tracked at
  all" and "nothing for this filter" with one message).
- **`components/ToolBadge.jsx`** — colored pill; fixed `tool → { label, color }` map for
  `claude-code` / `opencode` / `copilot`.
- **`components/CostBadge.jsx`** — colored by a pure `costTier(cost)` helper: `green` (`< $1`),
  `yellow` (`$1–$10`), `red` (`≥ $10`); renders `$X.XX`.
- **`components/TokenBar.jsx`** — 3-segment horizontal proportion bar: input / output / cache,
  where `cache = cache_read + cache_write` (computed by the caller, not inside `TokenBar`, so the
  component stays a pure `{ input, output, cache }` renderer).
- **`lib/format.js`** (new, pure functions, no React) — `shortenHomePath(path)` (regex-replaces a
  leading `/Users/<name>` or `/home/<name>` with `~`), `costTier(cost)`, `formatTokenCount(n)`
  (e.g. `1500` → `1.5k`). Extracted so they're unit-testable without a component-rendering
  framework.

## Error Handling

No new error path beyond what `DaemonGate` (already shipped) covers — if the daemon is down,
`DaemonGate` intercepts before `Projects.jsx` renders. A `getProjects()` fetch failure *after* the
daemon is confirmed up (e.g. a transient error on the 30s refresh) is logged to the console and the
previous successfully-fetched list is kept on screen — no error UI, no retry loop, matches the
"no retry loop" precedent set by `DaemonGate` in the scaffold.

## Testing

Reuses the repo's existing pattern (`node:test`, no new test-framework dependency):

- `tests/api.test.mjs` — extend the existing `GET /api/projects` test with assertions for the new
  `input_tokens`/`output_tokens`/`cache_read`/`cache_write` fields.
- `dashboard/src/lib/format.test.mjs` (new) — `node:test` assertions for `shortenHomePath`,
  `costTier`, `formatTokenCount`. Pure functions only; no DOM/component rendering is introduced for
  this bounded scope.

## Acceptance Criteria (from issue #9, verbatim)

- All tracked projects visible with correct stats
- Filter works
- CostBadge color thresholds correct
- Click navigates to project detail

## Explicitly Out of Scope

- Project Detail page content (Sessions/Memory tabs) — issue #10 (Memory) and the drill-down in
  issue #11 (AgentTrace) own that.
- Server-side filtering/pagination for `/api/projects` — the tracked-project count is small enough
  that client-side filtering over one fetched array is sufficient; revisit only if that stops being
  true.
- Any state-management library — `useState`/`useEffect` is sufficient for one page's local state.
