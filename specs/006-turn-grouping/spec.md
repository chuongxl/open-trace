# Turn grouping (#74)

Each Claude Code agent step is one `/v1/messages` request; most are tool-result continuations with no user text. The API now groups a user prompt and the text-less requests after it into one **turn**.

- **Read-time grouping** in `daemon/db/store.js` (`groupTurns`): no migration, fixes existing data. A text-less prompt joins the previous turn; a leading one with no turn before it stays its own row.
- `GET /api/sessions/:id` returns one row per turn: summed tokens, cost and `tool_call_count`, plus `request_count`.
- `GET /api/prompts/:id` (any request id of the turn) returns the turn: summed totals, the head request's text and raw payloads, and tool calls from all requests with `call_order` renumbered continuously.
- Write side: `extractUserText` returns null for a message holding a `tool_result`, so injected text blocks cannot make a continuation look like a prompt.
- OpenCode: assistant messages without a new user message now fold into the turn as well (watcher test updated).

Limits: raw request/response shown are the head request's only; per-request cost breakdown within a turn is not shown (follow-up if wanted).
