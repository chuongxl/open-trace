// OTLP/HTTP JSON trace receiver (#25): GenAI spans → sessions, prompts and tool calls.
// An agent instrumented with OpenTelemetry GenAI conventions can report here with no bespoke integration.
// Re-sent spans are ignored (ids are derived from span ids), so exporter retries do not double count.
import { upsertSession, insertPrompt, insertToolCall, getDb, promptExists, latestPromptBefore, nextCallOrder, setToolCallError } from '../db/store.js';
import { estimateCost } from '../pricing/models.js';
import { emit } from '../events.js';
import { mapTraces, OtlpError } from './mapper.js';

const cap = (v, n) => {
  const s = typeof v === 'string' ? v : v == null ? null : JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n) + '…' : s;
};

export function ingestTraces(body) {
  const { spans, skipped } = mapTraces(body);
  const sessions = new Map(); // sessionKey -> id
  const promptBySpan = new Map();
  const finished = [];
  let prompts = 0, toolCalls = 0;

  getDb().transaction(() => {
    for (const sp of spans) {
      if (sessions.has(sp.sessionKey)) continue;
      const id = `otel-${sp.sessionKey}`;
      sessions.set(sp.sessionKey, id);
      // Totals are accumulated per new prompt below; this only creates the row.
      upsertSession({ id, tool: 'otel', started_at: sp.startMs, project_path: sp.workdir ?? `otel:${sp.service}`, project_name: sp.service, model: sp.model, equiv_cost_usd: 0 });
    }

    const chats = spans.filter((s) => s.kind === 'chat').sort((a, b) => a.startMs - b.startMs);
    for (const sp of chats) {
      const sessionId = sessions.get(sp.sessionKey);
      const promptId = `otel-${sp.spanId}`;
      promptBySpan.set(sp.spanId, { id: promptId, sessionId, startMs: sp.startMs, traceId: sp.traceId });
      if (promptExists(promptId)) continue;
      const cost = estimateCost(sp.model, sp.usage);
      insertPrompt({
        id: promptId, session_id: sessionId, timestamp: sp.startMs, model: sp.model, input_text: sp.inputText,
        ...sp.usage, equiv_cost_usd: cost, first_token_ms: sp.firstTokenMs, request_ms: Math.max(0, sp.endMs - sp.startMs),
      });
      upsertSession({
        id: sessionId, tool: 'otel', started_at: sp.startMs, project_path: sp.workdir ?? `otel:${sp.service}`, project_name: sp.service, model: sp.model,
        total_input_tokens: sp.usage.input_tokens, total_output_tokens: sp.usage.output_tokens,
        total_cache_read: sp.usage.cache_read_tokens, total_cache_write: sp.usage.cache_write_tokens, equiv_cost_usd: cost,
      });
      prompts++;
      finished.push({ session_id: sessionId, prompt_id: promptId, model: sp.model, ended_at: sp.endMs, ...sp.usage, equiv_cost_usd: cost, tools: [] });
    }

    for (const sp of spans.filter((s) => s.kind === 'tool').sort((a, b) => a.startMs - b.startMs)) {
      const sessionId = sessions.get(sp.sessionKey);
      const callId = `otel-${sp.spanId}`;
      // Attach to the parent chat span, else the latest chat of the trace before it, else the latest prompt of the session.
      const candidates = [...promptBySpan.values()].filter((p) => p.traceId === sp.traceId && p.startMs <= sp.startMs).sort((a, b) => b.startMs - a.startMs);
      let promptId = promptBySpan.get(sp.parentSpanId)?.id ?? candidates[0]?.id ?? latestPromptBefore(sessionId, sp.startMs);
      if (!promptId) {
        promptId = `otel-tool-${sp.spanId}`; // a tool call with no model call around it still needs a row to hang on
        if (!promptExists(promptId)) insertPrompt({ id: promptId, session_id: sessionId, timestamp: sp.startMs, model: sp.model });
      }
      insertToolCall({
        id: callId, prompt_id: promptId, call_order: nextCallOrder(promptId), tool_use_id: sp.toolCallId, call_type: 'tool',
        name: sp.toolName, input: cap(sp.toolInput, 4000), output: cap(sp.toolOutput, 4000),
        duration_ms: Math.max(0, sp.endMs - sp.startMs), timestamp: sp.endMs,
      });
      if (sp.error) setToolCallError(callId);
      toolCalls++;
      const f = finished.find((x) => x.prompt_id === promptId);
      if (f) f.tools.push(sp.toolName);
    }
  })();

  for (const f of finished) emit('turn_finished', f);
  if (prompts || toolCalls) console.log(`[otel] ingested ${prompts} model calls, ${toolCalls} tool calls (${skipped} other spans ignored)`);
  return { prompts, toolCalls, skipped };
}

/** Express handler for POST /v1/traces. */
export function handleTraces(req, res) {
  if (!/json/i.test(req.headers['content-type'] ?? '')) {
    return res.status(415).json({ error: 'Only OTLP/HTTP with JSON is supported. Set OTEL_EXPORTER_OTLP_PROTOCOL=http/json.' });
  }
  try {
    ingestTraces(req.body);
    res.json({}); // OTLP: an empty object means everything was accepted
  } catch (err) {
    if (err instanceof OtlpError) return res.status(400).json({ error: err.message });
    console.error('[otel] ingest failed:', err.message);
    res.status(500).json({ error: 'Could not store the spans' });
  }
}
