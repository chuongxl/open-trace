# Proxy timing (#75)

The Claude proxy stamped every row with the storing time, so the trace could not show timing. Now:

- `prompts.timestamp` = request start (proxy receives the request); new `prompts.first_token_ms` (first upstream chunk − start) and `prompts.request_ms` (response end − start). Both null when timing is not supplied.
- `tool_calls.timestamp` = end of the response that issued the call. When the result arrives in the next request, `duration_ms` = that request's start − the call's timestamp. This is tool run time **plus any approval wait**; the trace tooltip says so.
- Plumbing: `parseStreamAndStore` / `parseNonStreaming` take an optional `{startedAt, firstTokenAt, endedAt}`; absent fields stay null so existing callers and tests are unchanged.
- Migration: `ADDED_COLUMNS` in `store.js` generalises the #54 ALTER; old databases gain the columns in place.
- Trace: `buildTrace` shows timing when timestamps differ **or** any `duration_ms` is set, so a single-call turn is no longer hidden. Old proxy rows (equal timestamps, no duration) still show order only.

Not done: a turn-level timeline view (request/first-token bars) — the data is available for #56.
