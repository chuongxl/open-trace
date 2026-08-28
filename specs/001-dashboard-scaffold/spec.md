# Dashboard Scaffold (Phase 5)

**Source:** GitHub issue [#8](https://github.com/chuongxl/open-trace/issues/8) — `[Phase 5] Dashboard scaffold — Vite + React + Tailwind + routing`
**Status:** approved

## Overview

Scaffold a React SPA (`dashboard/`) with a dark Tailwind theme and full client-side routing,
proxying API calls to the daemon (port 9900, per `CLAUDE.md`). This is scaffold-only: page
components are placeholders. Real data wiring for Projects/Memory/AgentTrace views belongs to
follow-on issues (#9, #10, #11); the WebLLM optimizer belongs to #12.

## Stack

- Vite 8 + React 19 (JSX), via `@vitejs/plugin-react`
- Oxlint ships with the template (`.oxlintrc.json`, `npm run lint`) — not ESLint
- TailwindCSS v4 (CSS-first `@theme` config), dark mode by default
- react-router-dom v7 — declarative `<BrowserRouter>`/`<Routes>` (not the data-router/loader API;
  no route needs a loader yet since pages are placeholders)
- recharts 2.x, lucide-react — installed, unused until #9+
- `@mlc-ai/web-llm` — installed now, used starting #12

## Routes

| Path | Page | Content (this issue) |
|---|---|---|
| `/` | Overview | placeholder |
| `/projects` | Projects | placeholder |
| `/projects/:path` | ProjectDetail | placeholder |
| `/sessions/:id` | SessionDetail | placeholder |
| `/prompts/:id` | PromptDetail | placeholder |

Each placeholder page renders a heading + an empty-state message ("no data yet") — no fetch calls.

## Components

- `App.jsx` — `<BrowserRouter>` + `<Routes>` + left sidebar layout, wraps routed content in
  `DaemonGate`.
- `components/Sidebar.jsx` — left nav, links to the 2 top-level routes (`/`, `/projects`); the 3
  detail routes (`ProjectDetail`, `SessionDetail`, `PromptDetail`) are parameterized and reached
  via parameterized links, to be added when #9/#10/#11 build real list-to-detail navigation.
- `components/LoadingSkeleton.jsx` — generic skeleton block, reusable by future pages.
- `components/DaemonGate.jsx` — on mount, calls `client.getHealth()`:
  - pending → renders `LoadingSkeleton`
  - success → renders `children` (the routed page)
  - failure/timeout → renders "Daemon not running" message, no retry loop (manual refresh)
- `pages/{Overview,Projects,ProjectDetail,SessionDetail,PromptDetail}.jsx` — placeholder content
  per the route table above.

## API Client

`src/api/client.js` exports one function per endpoint in `daemon/api/router.js` (already merged to
`main`), matching that contract exactly:

```
getHealth()                    GET /api/health
getOverview(days)              GET /api/overview?days=
getProjects()                  GET /api/projects
getSessions(params)            GET /api/sessions?tool=&project=&limit=&offset=
getSession(id)                 GET /api/sessions/:id
getSessionMemory(id)           GET /api/sessions/:id/memory
getPrompt(id)                  GET /api/prompts/:id
postOptimization(body)         POST /api/optimizations  (body includes prompt_id)
getOptimization(promptId)      GET /api/optimizations/:promptId
```

Only `getHealth` is called in this issue (by `DaemonGate`). The rest are exported and unused —
consumed by #9/#10/#11/#12.

## Dev Proxy

`vite.config.js` proxies `/api` → `http://localhost:9900` (the daemon dev port per `CLAUDE.md`).

## Error Handling

The only error path in scope is `DaemonGate`'s daemon-unreachable case, handled as described
above. No other error handling is in scope (no data fetching to fail yet).

## Testing

No test framework exists in `dashboard/` yet and none is being added for a scaffold with no
business logic. The one runnable check: `npm run build` succeeds, plus a small Node assertion
script (`dashboard/scripts/check-client-exports.mjs`) that imports `src/api/client.js` and asserts
all 9 functions above are exported as functions. Run via `node dashboard/scripts/check-client-exports.mjs`.

## Acceptance Criteria (from issue #8, verbatim)

- `npm run dev` → dark sidebar, all routes render
- API client exported (all 9 functions)
- Dev proxy routes correctly (`/api/health` reachable through Vite dev server when daemon is running)

## Explicitly Out of Scope

- Real page content / data fetching for Projects, Memory, Session/Prompt detail (#9, #10, #11)
- WebLLM optimizer (#12)
- Any state management library — none needed until pages fetch real data
