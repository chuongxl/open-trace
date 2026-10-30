# AgentTrace (Phase 5)

**Source:** GitHub issue [#11](https://github.com/chuongxl/open-trace/issues/11) — `[Phase 5] Feature: AgentTrace — project → session → prompt → call trace`
**Status:** proposed
**Classification:** Bounded — three placeholder pages (`ProjectDetail`, `SessionDetail`, `PromptDetail`) become real, plus one timeline component and a small pure-logic module. Builds on the scaffold (`specs/001-dashboard-scaffold`) and the Projects view (`specs/002-projects-view`).

## Overview

Drill-down from a project to the exact tool call behind a token spike:

```
Projects → Project (sessions) → Session (prompt table) → Prompt (agent trace)
```

The Prompt page shows the ordered tool calls of one prompt, each expandable to its raw input and output.

## Data reality (drives the design)

Two writers produce `tool_calls`, with different shapes:

| Writer | Rows per call | `call_type` | Timestamps | `output` |
|---|---|---|---|---|
| Claude Code proxy | 1 | `tool` | every call = time the response was stored (all equal) | filled from the next request (#54), else null |
| OpenCode watcher | 2, same `call_order` | `tool-call` (has `input`), `tool-result` (has `output`) | real, per row | on the result row |

Consequences:

1. The trace **merges rows by `call_order`**: input from the row that has it, output from the row that has it.
2. **Relative time is shown only when the data has real timing** — i.e. when the rows of the prompt carry more than one distinct timestamp. For proxy data, where every call shares the storing time, the UI shows order only; it never shows a row of `+0ms` that looks measured. Duration = result timestamp − call timestamp when both rows exist, else `duration_ms` when set, else omitted.
3. The issue sketch lists "model response text" rows. The response text is not stored separately (only a capped raw payload), so v1 shows **tool calls plus a final row** (`final response · N output tokens`). Extracting response text is a follow-up.

## Decisions

1. **Pure logic in `dashboard/src/lib/trace.js`**, unit-tested with `node --test` like `lib/format.js`: `toolKind`, `summarizeInput`, `formatDuration`, `prettyJson`, `buildTrace`.
2. **Kinds:** `mcp` (name starts with `mcp__`), `bash` (name `Bash`, case-insensitive), otherwise `tool`. Icons come from `lucide-react` (already a dependency), not emoji.
3. **`GET /api/sessions/:id` stops returning `raw_request` / `raw_response` per prompt** and adds `tool_call_count` per prompt. The session table does not need up to 64 KB of raw payload per row; `GET /api/prompts/:id` still returns the full prompt. The change only removes two heavy fields and adds one.
4. **`getToolCalls` orders by `call_order, timestamp`** so a call row sorts before its result row deterministically.
5. **Project Detail shows the Sessions list only.** The Memory tab belongs to #10; tabs are added there.
6. **Breadcrumb** `Projects > <project> > Session > Prompt` is a small shared component; the project name comes from the session. The project link uses `encodeURIComponent(project_path)`, as the Projects view does.
7. **The dashboard tests and build run in CI** (second job), since logic added here lives under `dashboard/` and is not covered by the root `npm test`.

## Components

| File | Purpose |
|---|---|
| `lib/trace.js` | pure logic above |
| `components/AgentTrace.jsx` | timeline: icon, `kind:name ← summary`, order/time/duration, collapsible raw input + output, final row |
| `components/Breadcrumb.jsx` | `Projects > project > Session > Prompt` |
| `pages/ProjectDetail.jsx` | sessions of one project (tool badge, started, model, tokens, cost) |
| `pages/SessionDetail.jsx` | session header + prompt table (time, prompt, model, tokens, cost, tool calls) |
| `pages/PromptDetail.jsx` | prompt header + `AgentTrace` |

Loading uses `LoadingSkeleton`; a failed fetch or unknown id shows an inline message. Costs stay labeled "equiv. cost" via the existing `CostBadge`.

## Out of scope

- Memory tab (#10), optimizer panel (#12), response-text rows, search/filter (#21).
- Real timing for proxy data (needs request-start and tool-boundary timestamps in the proxy); tracked as a follow-up.

## Acceptance

- Full drill-down works with real data: Projects → Project → Session → Prompt.
- Tool calls appear in `call_order`; an OpenCode call and its result appear as one step.
- Each step expands and collapses its raw input and output; missing output shows "no output captured".
- Proxy data shows no fabricated times; OpenCode data shows relative start and duration.
- Breadcrumb links navigate back up the chain.
- `npm test` (root and dashboard), `npm run lint` and `npm run build` pass.
