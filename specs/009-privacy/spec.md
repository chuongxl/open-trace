# Redaction and retention (#64)

- `daemon/redact.js`: linear regex patterns (token formats, Bearer, key=value incl. JSON-escaped text, private-key blocks incl. truncated ones), numbers/booleans after `token`-like names are left alone, idempotent, custom patterns from `REDACT_PATTERNS`, `REDACT=0` disables.
- Applied at the single write choke point (`db/store.js`: prompts, tool calls, tool outputs, optimizations) so every writer (proxy, OpenCode watcher) is covered, and in the proxy *before* capping raw text so a secret straddling the 32 KB cut cannot survive as a fragment. Forwarded traffic is never modified.
- `redactStoredRows()` / `npm run redact-stored` for existing data.
- `daemon/retention.js`: `RETENTION_DAYS` (default 0 = keep), prune at start and every 6 h via `store.pruneBefore` in one transaction (tool calls, optimizations, prompts, then empty sessions with alerts and overlay rows). The OpenCode watcher skips sessions whose last activity is outside the window.
- Decision: retention is off by default because deleting data should be opted into; redaction is on by default.
- Limits: pattern based; overlay guidance and its audit are stored as typed; the watcher skip is not covered by an automated test.
