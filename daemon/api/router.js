import { Router } from 'express';
import { readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as store from '../db/store.js';
import { config } from '../config.js';
import { subscribe } from '../events.js';
import { diffContext } from '../context.js';

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
