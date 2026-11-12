# OpenAI-compatible proxy (#28)

`daemon/proxy/openai-proxy.js`, routed from the existing proxy port: a POST to a path ending in `chat/completions|completions|embeddings|responses` without an `anthropic-version` header is OpenAI-shaped; everything else keeps the Anthropic path. Only `chat/completions` is parsed and stored (same tables as Claude Code); the rest is piped to `OPENAI_UPSTREAM` (default `https://api.openai.com`).

- Mapping: `prompt_tokens - cached` → input, `completion_tokens` → output, `prompt_tokens_details.cached_tokens` → cache read; `tool_calls` (joined by index when streamed) → `tool_calls` rows with `tool_use_id = call id`; the next request's `role:"tool"` messages fill the outputs and durations; a request whose last message is a tool result is a continuation (text-less, grouped under the prompt, #74). Context sections come from an Anthropic-shaped view of the messages (`toAnthropicShape`) so the context inspector works.
- Streaming: tee as in the Claude path; usage is read from the final chunk; `stream_options.include_usage` is added for api.openai.com (or `OPENAI_INJECT_USAGE=1`).
- Project: `/_cwd/<base64url>` base-URL prefix, then prompt markers (Cline/Roo "Current Working Directory (…)", "Primary working directory:", `cwd:`), else a conversation hash (first system + user message) as session key. Client label (`tool`) from User-Agent or system prompt: aider, continue, cline, roo-code, else openai-compat.
- Forwarded with `accept-encoding: identity` (parsed as text, like #88). Errors are passed through and not stored.
- Observe only: the debugger and overlay hooks do not run for these requests (their synthetic replies and validators are Anthropic-shaped). Dashboard: `lib/tools.js` lists tools; the context inspector link shows for proxied tools, debugger controls for Claude Code only.
- `setup.sh` exports `OPENAI_API_BASE` only when `aider` is installed.
- Not verified against real Aider/Continue/Cline/Roo builds or a real OpenAI key; tested against a fake OpenAI upstream (non-streaming, SSE with fragmented tool calls, gzip, errors, routing).
