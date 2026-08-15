import { Router } from 'express';
import { readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as store from '../db/store.js';
import { config } from '../config.js';

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

// ─── Memory ───────────────────────────────────────────────────────────────────
router.get('/sessions/:id/memory', (req, res) => {
  const session = store.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const files = [];

  // Project-local memory
  if (session.project_path) {
    const localPath = join(session.project_path, '.claude', 'memory.md');
    if (existsSync(localPath)) {
      try {
        const stat = statSync(localPath);
        files.push({
          path: localPath,
          display: '.claude/memory.md (project)',
          content: readFileSync(localPath, 'utf8'),
          size: stat.size,
          modified_at: stat.mtimeMs,
        });
      } catch {}
    }
  }

  // Global CLAUDE.md
  const globalPath = join(homedir(), '.claude', 'CLAUDE.md');
  if (existsSync(globalPath)) {
    try {
      const stat = statSync(globalPath);
      files.push({
        path: globalPath,
        display: '~/.claude/CLAUDE.md (global)',
        content: readFileSync(globalPath, 'utf8'),
        size: stat.size,
        modified_at: stat.mtimeMs,
      });
    } catch {}
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
