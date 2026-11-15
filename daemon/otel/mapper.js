// OTLP/HTTP JSON traces → normalized GenAI spans (#25). Pure; storage is in ingest.js.
// Attribute names follow the OpenTelemetry GenAI semantic conventions, including the older
// `gen_ai.usage.prompt_tokens` / `completion_tokens` names still emitted by many instrumentations.

export class OtlpError extends Error {}

/** OTLP AnyValue → JS value. */
function anyValue(v) {
  if (v == null || typeof v !== 'object') return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return Number(v.intValue); // JSON encodes 64-bit ints as strings
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('boolValue' in v) return v.boolValue;
  if ('arrayValue' in v) return (v.arrayValue?.values ?? []).map(anyValue);
  if ('kvlistValue' in v) return attrs(v.kvlistValue?.values);
  return undefined;
}

function attrs(list) {
  const out = {};
  for (const kv of Array.isArray(list) ? list : []) if (kv && typeof kv.key === 'string') out[kv.key] = anyValue(kv.value);
  return out;
}

const nanoToMs = (n) => {
  const ms = Number(BigInt(n ?? 0) / 1_000_000n);
  return Number.isFinite(ms) ? ms : 0;
};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v) => (typeof v === 'string' && v !== '' ? v : undefined);
const first = (a, ...keys) => { for (const k of keys) if (a[k] !== undefined) return a[k]; return undefined; };

/** Text of the last user message, from the places GenAI instrumentations put it. */
function promptText(a, events) {
  const fromMessages = (raw) => {
    let msgs = raw;
    if (typeof raw === 'string') { try { msgs = JSON.parse(raw); } catch { return raw; } }
    if (!Array.isArray(msgs)) return undefined;
    const user = [...msgs].reverse().find((m) => m?.role === 'user');
    if (!user) return undefined;
    const c = user.content ?? user.parts;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text ?? p?.content ?? '')).filter(Boolean).join('\n');
    return undefined;
  };
  const direct = fromMessages(a['gen_ai.input.messages']);
  if (direct) return direct;
  const legacy = a['gen_ai.prompt'];
  if (typeof legacy === 'string') return legacy;
  for (const e of [...events].reverse()) {
    if (e.name === 'gen_ai.user.message') return str(e.attributes.content) ?? str(e.attributes['gen_ai.event.content']);
    if (e.name === 'gen_ai.client.inference.operation.details') { const t = fromMessages(e.attributes['gen_ai.input.messages']); if (t) return t; }
  }
  return undefined;
}

/**
 * @returns {{kind: 'chat'|'tool', traceId, spanId, parentSpanId, sessionKey, service, workdir, startMs, endMs,
 *            model, usage, inputText, toolName, toolCallId, toolInput, toolOutput, error}[]}
 * Spans that are not GenAI chat/tool spans are skipped; `skipped` counts them.
 */
export function mapTraces(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.resourceSpans)) {
    throw new OtlpError('Expected an OTLP/JSON traces payload with a resourceSpans array');
  }
  const spans = [];
  let skipped = 0;
  for (const rs of body.resourceSpans) {
    if (!rs || typeof rs !== 'object') throw new OtlpError('resourceSpans entries must be objects');
    const res = attrs(rs.resource?.attributes);
    for (const ss of Array.isArray(rs.scopeSpans) ? rs.scopeSpans : []) {
      for (const sp of Array.isArray(ss?.spans) ? ss.spans : []) {
        if (!sp || typeof sp !== 'object' || typeof sp.spanId !== 'string' || typeof sp.traceId !== 'string') throw new OtlpError('Each span needs a traceId and spanId');
        const a = attrs(sp.attributes);
        const events = (Array.isArray(sp.events) ? sp.events : []).map((e) => ({ name: e?.name, attributes: attrs(e?.attributes) }));
        const op = str(a['gen_ai.operation.name']);
        const toolName = str(a['gen_ai.tool.name']);
        const input = first(a, 'gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens');
        const output = first(a, 'gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens');
        const isTool = op === 'execute_tool' || (toolName && !op);
        const isChat = !isTool && (['chat', 'text_completion', 'generate_content'].includes(op) || input !== undefined || output !== undefined);
        if (!isTool && !isChat) { skipped++; continue; }

        const cacheRead = num(first(a, 'gen_ai.usage.cache_read.input_tokens', 'gen_ai.usage.cache_read_input_tokens')) ?? 0;
        const cacheWrite = num(first(a, 'gen_ai.usage.cache_creation.input_tokens', 'gen_ai.usage.cache_creation_input_tokens')) ?? 0;
        const total = num(input) ?? 0;
        const ttft = num(a['gen_ai.response.time_to_first_chunk']);
        spans.push({
          kind: isTool ? 'tool' : 'chat',
          traceId: sp.traceId, spanId: sp.spanId, parentSpanId: str(sp.parentSpanId) ?? null,
          sessionKey: str(a['gen_ai.conversation.id']) ?? str(a['session.id']) ?? sp.traceId,
          service: str(res['service.name']) ?? 'unknown-service',
          workdir: str(res['process.working_directory']) ?? str(a['process.working_directory']) ?? null,
          startMs: nanoToMs(sp.startTimeUnixNano), endMs: nanoToMs(sp.endTimeUnixNano),
          model: str(a['gen_ai.response.model']) ?? str(a['gen_ai.request.model']) ?? null,
          // gen_ai input tokens include cached tokens; open-trace stores fresh input separately from cache reads.
          usage: { input_tokens: Math.max(0, total - cacheRead - cacheWrite), output_tokens: num(output) ?? 0, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite },
          firstTokenMs: ttft !== undefined ? Math.round(ttft * 1000) : null,
          inputText: isChat ? promptText(a, events) ?? null : null,
          toolName: toolName ?? str(a['gen_ai.tool.call.name']) ?? sp.name ?? 'unknown',
          toolCallId: str(a['gen_ai.tool.call.id']) ?? null,
          toolInput: first(a, 'gen_ai.tool.call.arguments', 'gen_ai.tool.arguments') ?? null,
          toolOutput: first(a, 'gen_ai.tool.call.result', 'gen_ai.tool.result') ?? null,
          error: sp.status?.code === 2 || sp.status?.code === 'STATUS_CODE_ERROR',
        });
      }
    }
  }
  return { spans, skipped };
}
