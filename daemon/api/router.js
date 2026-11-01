import { Router } from 'express';
import { readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as store from '../db/store.js';
import { config } from '../config.js';
import { subscribe, emit } from '../events.js';
import { diffContext } from '../context.js';
import * as debug from '../debugger.js';
import { applyRules, checkRule, editsFrom, cacheImpact, isPassthrough, setPassthrough } from '../overlay.js';

const router = Router();

// ─── Health ──────────────────────────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), version: config.version });
});

// ─── Overview ─────────────────────────────────────────────────────────────────
router.get('/overview', (req, res) => {
  const days = Math.min(Number(req.query.days ?? 30), 365);
  res.json(store.getOverviewStats(days));
});

// ─── Projects ─────────────────────────────────────────────────────────────────
router.get('/projects', (req, res) => {
  res.json(store.getProjects());
});

// ─── Sessions ─────────────────────────────────────────────────────────────────
router.get('/sessions', (req, res) => {
  const { tool, project, limit = 50, offset = 0 } = req.query;
  res.json(store.getSessions({ tool, project, limit: Number(limit), offset: Number(offset) }));
});

router.get('/sessions/:id', (req, res) => {
  const session = store.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const prompts = store.getPrompts(req.params.id);
  res.json({ ...session, prompts });
});

// ─── Live feed + context ──────────────────────────────────────────────────────
// Server-Sent Events: turn_started, turn_finished, session_updated (see daemon/events.js).
router.get('/live', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  const unsubscribe = subscribe((e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`));
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25000);
  req.on('close', () => { unsubscribe(); clearInterval(heartbeat); });
});

router.get('/sessions/:id/alerts', (req, res) => {
  if (!store.getSession(req.params.id)) return res.status(404).json({ error: 'Session not found' });
  res.json({ alerts: store.getAlerts(req.params.id) });
});

// ─── Session debugger (Phase 14) ──────────────────────────────────────────────
router.get('/sessions/:id/debug', (req, res) => {
  if (!store.getSession(req.params.id)) return res.status(404).json({ error: 'Session not found' });
  res.json(debug.describe(req.params.id));
});

for (const [action, fn] of Object.entries({ pause: debug.pause, step: debug.step, continue: debug.resume, stop: debug.stop })) {
  router.post(`/sessions/:id/${action}`, (req, res) => {
    if (!store.getSession(req.params.id)) return res.status(404).json({ error: 'Session not found' });
    const out = fn(req.params.id);
    if (out.error) return res.status(409).json({ error: out.error });
    res.json(out);
  });
}

router.post('/sessions/:id/break-on-alert', (req, res) => {
  if (!store.getSession(req.params.id)) return res.status(404).json({ error: 'Session not found' });
  res.json(debug.setBreakOnAlert(req.params.id, req.body?.enabled === true));
});

// ─── Context overlay (Phase 15) ───────────────────────────────────────────────
const sessionOr404 = (req, res) => {
  if (store.getSession(req.params.id)) return true;
  res.status(404).json({ error: 'Session not found' });
  return false;
};

/** Dry-run a candidate rule against the held request: effect, validity and one-time cache cost. */
function previewRule(sessionId, kind, params) {
  const body = debug.heldBody(sessionId);
  if (!body) return null;
  const rules = store.getOverlayRules(sessionId);
  const candidate = { id: 0, kind, params, anchor: null };
  const { effects, problems, body: out } = applyRules(body, [...rules, candidate]);
  const effect = effects.find((e) => e.rule_id === 0);
  const problemsList = problems.length ? problems : effect && !effect.ok ? [effect.note] : [];
  return {
    valid: problemsList.length === 0,
    problems: problemsList,
    note: effect?.note ?? null,
    messages_before: body.messages.length,
    messages_after: out.messages.length,
    cache: cacheImpact(body, editsFrom(candidate, body)),
  };
}

router.get('/overlay', (_req, res) => res.json({ passthrough: isPassthrough() }));
router.post('/overlay/passthrough', (req, res) => {
  setPassthrough(req.body?.enabled === true);
  res.json({ passthrough: isPassthrough() });
});

router.get('/sessions/:id/overlay', (req, res) => {
  if (!sessionOr404(req, res)) return;
  res.json({ passthrough: isPassthrough(), rules: store.getOverlayRules(req.params.id), audit: store.getOverlayAudit(req.params.id) });
});

router.post('/sessions/:id/overlay/preview', (req, res) => {
  if (!sessionOr404(req, res)) return;
  const { kind, params } = req.body ?? {};
  const bad = checkRule(kind, params);
  if (bad.length) return res.status(400).json({ error: bad.join('; ') });
  const preview = previewRule(req.params.id, kind, params);
  if (!preview) return res.status(409).json({ error: 'Pause the session and wait for a held request to preview an edit.' });
  res.json(preview);
});

router.post('/sessions/:id/overlay/rules', (req, res) => {
  if (!sessionOr404(req, res)) return;
  const { kind, params } = req.body ?? {};
  const bad = checkRule(kind, params);
  if (bad.length) return res.status(400).json({ error: bad.join('; ') });
  const preview = previewRule(req.params.id, kind, params); // null when nothing is held: validated when applied
  if (preview && !preview.valid) return res.status(400).json({ error: preview.problems.join('; '), preview });
  const rule = store.addOverlayRule(req.params.id, kind, params);
  store.addOverlayAudit({ session_id: req.params.id, rule_id: rule.id, action: 'rule_added', detail: `${kind} ${JSON.stringify(params)}` });
  emit('overlay_changed', { session_id: req.params.id });
  res.status(201).json({ rule, preview });
});

router.delete('/sessions/:id/overlay/rules/:ruleId', (req, res) => {
  if (!sessionOr404(req, res)) return;
  const id = Number(req.params.ruleId);
  if (!store.removeOverlayRule(req.params.id, id)) return res.status(404).json({ error: 'Rule not found' });
  store.addOverlayAudit({ session_id: req.params.id, rule_id: id, action: 'rule_removed' });
  emit('overlay_changed', { session_id: req.params.id });
  res.json({ ok: true });
});

// Per-request context size by section (chars; the UI shows ~chars/4 tokens) and the diff vs the previous request.
router.get('/sessions/:id/context', (req, res) => {
  if (!store.getSession(req.params.id)) return res.status(404).json({ error: 'Session not found' });
  let prev = null;
  const turns = store.getContextRows(req.params.id).map((row) => {
    const ctx = JSON.parse(row.context);
    const turn = {
      prompt_id: row.id, timestamp: row.timestamp, input_text: row.input_text,
      input_tokens: row.input_tokens, output_tokens: row.output_tokens, cache_read_tokens: row.cache_read_tokens,
      sections: ctx.sections, message_count: ctx.message_count,
      total_chars: Object.values(ctx.sections).reduce((a, b) => a + b, 0),
      diff: diffContext(prev, ctx),
    };
    prev = ctx;
    return turn;
  });
  res.json({ turns });
});

// ─── Memory ───────────────────────────────────────────────────────────────────
router.get('/sessions/:id/memory', (req, res) => {
  const session = store.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // Instruction/memory files the AI loads for this project, most specific first.
  const candidates = [];
  if (session.project_path) {
    candidates.push(
      { path: join(session.project_path, 'CLAUDE.md'), display: 'CLAUDE.md (project)' },
      { path: join(session.project_path, '.claude', 'memory.md'), display: '.claude/memory.md (project)' },
    );
  }
  candidates.push({ path: join(homedir(), '.claude', 'CLAUDE.md'), display: '~/.claude/CLAUDE.md (global)' });

  const files = [];
  for (const { path, display } of candidates) {
    if (!existsSync(path)) continue;
    try {
      const stat = statSync(path);
      files.push({ path, display, content: readFileSync(path, 'utf8'), size: stat.size, modified_at: stat.mtimeMs });
    } catch { /* unreadable file: skip */ }
  }

  res.json({ files });
});

// ─── Prompts ──────────────────────────────────────────────────────────────────
router.get('/prompts/:id', (req, res) => {
  const prompt = store.getPrompt(req.params.id);
  if (!prompt) return res.status(404).json({ error: 'Prompt not found' });
  const toolCalls = store.getToolCalls(req.params.id);
  res.json({ ...prompt, tool_calls: toolCalls });
});

// ─── Optimizations ────────────────────────────────────────────────────────────
router.post('/optimizations', (req, res) => {
  const { id, prompt_id, original_prompt, optimized_prompt,
          improvement_notes, token_delta, webllm_model } = req.body;
  if (!id || !prompt_id) return res.status(400).json({ error: 'id and prompt_id required' });
  store.insertOptimization({
    id, prompt_id, original_prompt, optimized_prompt,
    improvement_notes, token_delta, webllm_model,
    created_at: Date.now(),
  });
  res.json({ ok: true });
});

router.get('/optimizations/:promptId', (req, res) => {
  const opt = store.getOptimization(req.params.promptId);
  res.json(opt ?? null);
});

export default router;
