# open-trace

> ⚠️ **Work in progress.** This project is not complete and features described below are not fully functional yet. Waiting on the first version release — expect breaking changes.

Local AI usage observatory — track every prompt, token, and tool call across Claude Code, OpenCode, and GitHub Copilot. No external API calls. Subscription-safe.

## Architecture

```
Claude Code ──ANTHROPIC_BASE_URL──► proxy [:9876] ──► api.anthropic.com
                                    [intercept + log]

OpenCode ──────────────────────► SQLite watcher
                                    ~/.local/share/opencode/opencode.db

Copilot ───────────────────────► copilot-tracer watcher / proxy

All tools ──► ~/.open-trace/data.db (SQLite)
          ──► React dashboard [:9900]
```

## 4 Core Features

### 1. 📁 Projects View
All tracked local projects at a glance — source folder, session count, total tokens, equivalent cost, last active. Filter by tool (Claude Code / OpenCode / Copilot).

### 2. 🧠 Memory View
Per-project AI memory browser — see what context the AI holds about each codebase. Reads `.claude/memory.md` and `~/.claude/CLAUDE.md`, rendered as markdown.

### 3. 🔍 AgentTrace
Full drill-down: **Project → Session → Prompt → Call trace**. See every tool call with input/output and relative timestamps. Expand any item for raw JSON.

### 4. ✨ Prompt Optimizer
Click “Analyze & Optimize” on any prompt — a small LLM runs **entirely in your browser** (WebGPU, zero external calls) and returns an improved version with change notes.

## Quick Start

```bash
git clone https://github.com/chuongxl/open-trace.git
cd open-trace
./setup.sh      # Node >= 22; installs deps, builds dashboard, adds env to your shell profile, registers auto-start (launchd/systemd). Safe to re-run.
```

Then open the dashboard in your browser at the dashboard port.

## Tool Interception

| Tool | Method | Setup |
|------|--------|-------|
| Claude Code | HTTP proxy via `ANTHROPIC_BASE_URL` | Auto-added by `./setup.sh` |
| OpenCode | SQLite file watcher | Automatic |
| GitHub Copilot | copilot-tracer watcher | See [#13](../../issues/13) |

## Cost Display

All costs use **public API reference rates** as an efficiency metric — not actual billing. Labeled “equiv. cost” throughout.

## Prompt Optimizer Requirements

- Chrome or Edge with WebGPU
- ~2.2GB free (Phi-3.5-mini, cached after first load)
- Light alternative: Qwen2.5-1.5B (~1GB)

## Tech Stack

**Daemon:** Node.js ESM · Express · better-sqlite3 · chokidar  
**Dashboard:** React 19 · Vite 6 · TailwindCSS v4 · recharts · @mlc-ai/web-llm  
**Storage:** SQLite at `~/.open-trace/data.db`

## Development

```bash
# Daemon
cd daemon && node --watch index.js

# Dashboard (hot reload)
cd dashboard && npm run dev
```

## Local API security

The daemon binds to `127.0.0.1`, but browsers can still reach it, so the API is guarded (`daemon/security.js`):

- `Host` must be `localhost`, `127.0.0.1` or `[::1]` on the daemon port (blocks DNS rebinding).
- A browser `Origin` must be the dashboard itself or the Vite dev server (`localhost:5173`); anything else gets 403 and no CORS grant. Add more with `OPEN_TRACE_ALLOWED_ORIGINS=https://a,https://b`.
- Non-GET requests need `Authorization: Bearer <token>`. The token is generated on first start at `~/.open-trace/token` (mode 0600, next to the DB); the dashboard fetches it from `GET /api/token`, which only allowed origins can read. Local scripts can read the file.

Not covered: other local processes running as you can read the token file, and the proxy ports (9876/9877) are unauthenticated by design (the client talks to them directly).

## Known Limitations

- Copilot inline completions: estimated as `chars/4` (shown with `~` prefix)
- Prompt Optimizer: WebGPU required (Chrome/Edge only)
- OpenCode watcher: requires default DB path

## Project Board

[open-trace project board](https://github.com/users/chuongxl/projects/5)

## Contributing

Pick any open issue, branch from `main`, and implement the feature using the
`speckit-auto` skill. Your PR must include the generated `spec/{feature}`
artifact for review, and reference the issue number.
