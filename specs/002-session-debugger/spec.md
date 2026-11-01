# Session Debugger (Phases 12–15)

**Status:** proposed
**Diagrams:** `docs/to-be-architecture.html` (system), `docs/session-debugger-flow.html` (pause / inject / resume / stop)

## Problem

An engineer sends a prompt to an agentic coding tool and waits. When the result is wrong they
cannot tell why, and cannot intervene until the run finishes. There is no equivalent of an IDE
debugger for an agent session.

## Idea

Every agent step is one `POST /v1/messages` that carries the agent's whole state (system prompt,
message history, tools, tool results). open-trace's Claude proxy already sits on that path
(`daemon/proxy/claude-proxy.js`). Add a **hold → inspect → mutate → release** stage so the
engineer can pause, look at the context, steer, and continue or stop — live.

Scope: **Claude Code only** (proxy path). Other tools stay *Observe* tier (watchers, read-only)
until they can be pointed at the proxy via a base-URL setting.

## Debugger concepts

| IDE | Agent equivalent |
|---|---|
| Breakpoint | Hold a request before it is forwarded (global, or conditional) |
| Step | Release exactly one model turn, then re-hold |
| Continue | Release and clear breakpoints |
| Stop | Reply with a synthetic `end_turn` so the client halts cleanly |
| Variables | Context composition: system / CLAUDE.md / tools / history / tool results |
| Diff | Context diff between consecutive requests |
| Hot-patch | Inject a user message, trim or delete a message (Phase 15) |

## Phases

### Phase 12 — Capture foundation
- **12a** Fix `curId=null` ReferenceError in `parseStreamAndStore` (`claude-proxy.js:311`); it throws on every `content_block_stop`, is swallowed at the call site, and no streamed prompt is stored. Regression test with a recorded SSE fixture.
- **12b** Store tool results. `tool_calls.output` is always null today. The result for turn N's `tool_use` arrives as a `tool_result` block in turn N+1's request; match on `tool_use_id` and fill `output`.
- **12c** Request pipeline in the proxy: assign a `requestId`, expose a `hold(requestId)` hook between body buffering and `forward*`, and recompute `content-length` whenever the body is replaced. Default behaviour (no hook active) must be byte-identical pass-through.
  - *Implemented (#55):* `setRequestHook(fn)` in `claude-proxy.js`. `fn({requestId, body, headers, signal})` may stay pending (hold) and may resolve `{ body }` to replace the request (re-serialised, `content-length` recomputed, `transfer-encoding` dropped). Fail-open: a throwing hook forwards the original. `signal` aborts if the client disconnects while held, and the held request is then dropped. Non-JSON bodies skip the hook. `createClaudeProxy(port, { upstream })` makes the forward target injectable for tests. `startedAt` timing (#75) is taken after the hold, so pause time is not counted as model latency.

### Phase 13 — Live inspection (read-only)
- **13a** Live event feed: `GET /api/live` (Server-Sent Events; Express, no new dependency). Events: `turn_started`, `turn_finished`, `session_updated`.
- **13b** Context inspector: per-turn token breakdown by section (estimated as chars/4, shown with `~`) and a context diff vs the previous turn (what was added, which tool result is largest).
  - *Implemented (#56, 13a+13b):* `daemon/events.js` bus; `GET /api/live` SSE (`turn_started` from the proxy when a request is forwarded, `turn_finished` after it is stored, `session_updated` from every `upsertSession`; 25 s keep-alive comments). `GET /api/sessions/:id/context` returns one entry per proxied request: section sizes in chars (system, tools, CLAUDE.md, conversation, tool results), message count, and a diff vs the previous request (per-section delta, new message count, largest new tool result, `compacted` when history shrank). Sizes come from `daemon/context.js`, computed at write time from the full request and stored in `prompts.context` (the stored `raw_request` is capped at 32 KB and unusable for this). CLAUDE.md is detected heuristically from Claude Code's `<system-reminder>` blocks that mention it. Dashboard: `/sessions/:id/context` (link on Claude Code sessions) with a stacked bar per request, live indicator, and refetch on this session's events. Sessions recorded before this change have no context data and say so. Not covered: OpenCode/Copilot (no request body), per-turn live "running now" state, auth on `/api/live` (GET, guarded by Host/Origin like other reads).
- **13c** Stuck-agent detectors: same tool + same input ≥ N times, same failing tool result ≥ N times, context > X% of window, cost > $X (labeled equiv. cost). Emit `alert` events; no control yet.

  - *Implemented (#57, 13c):* `daemon/detectors.js` listens for `turn_finished` and evaluates the session's recent state (stateless; reads the DB, so it survives restarts). Four detectors: same tool + same input N in a row (`repeat_call`), same failing result N times in the last 20 calls (`repeat_error`; needs `tool_calls.is_error`, now stored from the `tool_result` block), prompt tokens (fresh + cached) above X% of the window (`context_high`), session equiv. cost above $X (`cost_high`). Each condition raises one alert (`alerts` table, unique per session + dedupe key), pushed as an `alert` event on `/api/live`, and listed by `GET /api/sessions/:id/alerts` and on the context inspector page. Thresholds in `config.detectors`, env `DETECT_REPEAT_CALLS=3`, `DETECT_REPEAT_ERRORS=3`, `DETECT_CONTEXT_PCT=80`, `CONTEXT_WINDOW_TOKENS=200000`, `DETECT_COST_USD=5`; 0 disables one. The window size is configured, not detected: set 1000000 for 1M-context models. Observe only; Phase 14 can use alerts as breakpoints.

### Phase 14 — Pause / step / continue / stop
- Per-session state machine: `running | pausing | paused | stopping`.
- `POST /api/sessions/:id/{pause,step,continue,stop}`; held requests live in an in-memory map keyed by `requestId`.
- Pause takes effect at the next request boundary (the current response is never cut mid-stream).
- Stop returns a synthetic `end_turn` assistant message ("Stopped by open-trace") in both streaming and non-streaming shape.
- Conditional breakpoints from the 13c detectors ("pause when the alert fires").
- UI: session header with state badge and Pause / Step / Continue / Stop; desktop notification on auto-pause.
- The setup path exports a raised `API_TIMEOUT_MS` so a held request does not time out the client (README references `./setup.sh`, which is not in the repo yet; see #14).

**Implemented (#58).** `daemon/debugger.js` is the proxy's request hook. Per-session mode in memory: `running | pausing | paused | stopping`.
- `POST /api/sessions/:id/{pause,step,continue,stop}` (token required, #62), `GET /api/sessions/:id/debug`, `POST /api/sessions/:id/break-on-alert {enabled}`. `step` with nothing held is 409.
- **Pause** takes effect at the next request; the in-flight response is never cut. **Step** releases the oldest held request and re-holds the next. **Continue** releases all and stops holding (also cancels an armed stop). **Stop** answers held requests with a synthetic `end_turn` ("Stopped by open-trace.", `daemon/proxy/synthetic.js`, JSON and SSE shapes, no upstream call). With nothing held, stop is *armed* for 60 s and applies only to the next tool-loop continuation (last user message is a `tool_result`), never to a fresh prompt the engineer types.
- Only requests that carry `tools` are held; Claude Code's small background calls (titles, summaries) pass through.
- A client that disconnects while held is dropped. Events: `debug_state` (with a `reason`) and `turn_stopped` on `/api/live`.
- **Break on alert:** a per-session opt-in; a detector alert (#57) switches the session to pause mode. The dashboard asks for desktop-notification permission when it is enabled and notifies on that auto-pause.
- UI: `DebugControls` (state badge, four buttons enabled per state, break-on-alert checkbox) on the session page and the context inspector page, Claude Code sessions only.
- A held request keeps the client waiting, so `setup.sh` exports `API_TIMEOUT_MS=600000` (#14). Not done: keep-alive bytes to a held streaming client; persisted debugger state or audit trail (state resets on daemon restart; the audit trail is Phase 15).

### Phase 15 — Inject and edit context
- **Overlay**: an ordered list of rules stored per session and reapplied to every request, because the client resends its own history each turn. Rule kinds: `append_user_message`, `replace_message`, `truncate_tool_result`, `delete_message`.
- **Validator** before apply: every `tool_use` keeps its `tool_result`; signed thinking blocks are never edited; result must still parse as a valid Messages request.
- **Cache cost preview**: editing before the cache breakpoint invalidates the prompt-cache prefix; show the estimated extra equiv. cost before the engineer confirms.
- **Audit trail**: every rule and its effect is stored and shown on the session timeline (the client transcript will not show it).
- Global **pass-through** toggle disables the overlay entirely.

**Implemented (#59).** `daemon/overlay.js` (rules, validator, cache estimate, proxy hook), tables `overlay_rules` / `overlay_audit`, `daemon/hooks.js` (debugger decides hold/stop first, then the overlay edits what is released).
- **Rules** are stored per session and applied on every request: `append_user_message {text}`, `replace_message {index, text}` (plain-text messages only), `truncate_tool_result {max_chars, tool_use_id?}`, `delete_message {indices}`. Index rules refer to the client's original history and are resolved before injections, so an injection never shifts them.
- **Injection** is anchored at first use to the end of the history as it was, and re-inserted at that point on later turns (the client resends a history without it). After a user message it is merged into that message after any `tool_result` blocks; after an assistant message it becomes a new user message.
- **Validator** (every apply, and at creation when a request is held): starts with a user message, no empty messages, every `tool_use` has its `tool_result` in the next message and vice versa, thinking/redacted_thinking blocks identical to the original. A rule can never edit or delete a message with thinking blocks. **An invalid result is never forwarded**: the whole overlay is skipped for that request, the original goes through, and the audit records why.
- **Cache preview**: tokens from the first edited message onward are re-written to the prompt cache, so extra equiv. cost = tokens × (cache-write − cache-read rate), shown once before confirming (chars/4 estimate; savings from truncation/deletion are not netted).
- **API** (mutations need the #62 token): `GET /api/sessions/:id/overlay` (rules + audit), `POST .../overlay/preview` (dry run against the held request, 409 if none), `POST .../overlay/rules` (400 if the dry run is invalid; accepted unvalidated when nothing is held), `DELETE .../overlay/rules/:ruleId`, `GET/POST /api/overlay[/passthrough]`. Events `overlay_changed`, `overlay_applied`.
- **Audit** rows: `rule_added`, `rule_removed`, `applied` (with the effect), `skipped`, `rejected`, `passthrough_on/off`. Shown in the overlay panel on the context inspector page. **Pass-through** (UI toggle or `OPEN_TRACE_PASSTHROUGH=1`) disables all rules; the setting is in memory.
- **UI** (`OverlayPanel`): inject guidance and trim tool results, preview (needs a held request), rule list with remove, audit trail. Replace and delete are API-only for now (they need a message picker).

### Later (not in this spec)
Tool-level control (hold the response, edit or deny a `tool_use`; requires SSE rewriting), rewind / fork / what-if replay with git checkpoints, subagent call-stack grouping.

## Requirements

- Default behaviour with no breakpoints and an empty overlay is unchanged pass-through, no added latency beyond a map lookup.
- Control endpoints bind to `127.0.0.1` only (as the daemon does today); mutation endpoints are the reason to keep it that way.
- Streaming latency is preserved on released requests (chunks are still teed as received).
- Costs stay labeled "equiv. cost".
- ESM only, Node >= 18; no new runtime dependency unless justified in the issue.

## Risks

| Risk | Mitigation |
|---|---|
| Client timeout while held | Export a raised `API_TIMEOUT_MS` from setup; show hold duration in UI |
| Invalid request after an edit | Validator in Phase 15; reject, never forward invalid bodies |
| Prompt-cache invalidation | Preview extra cost; prefer edits near the end of history |
| Client drift (injection not in Claude Code transcript) | Audit trail on timeline; documented behavior |
| Subagent requests look like separate sessions | Out of scope; heuristic later |
| Proxy mutates requests | Audit trail, pass-through toggle, loopback-only |

## Acceptance (Phase 14 demo)

1. Start `claude` through the proxy; ask for a multi-step task.
2. Click Pause: after the in-flight turn completes, the next request is held and the UI shows the full context.
3. Click Step: exactly one turn runs and the session pauses again.
4. Click Continue: the run finishes normally.
5. Repeat and click Stop: Claude Code ends the turn with the synthetic message, with no error or hang.
