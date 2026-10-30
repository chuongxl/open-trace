import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync } from 'fs';
import { config } from './config.js';
import { guard, loadToken, DEV_ORIGINS } from './security.js';
import apiRouter from './api/router.js';
import { getDb } from './db/store.js';
import { createClaudeProxy } from './proxy/claude-proxy.js';
import { startOpenCodeWatcher } from './watchers/opencode-watcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Initialise DB at startup: creates ~/.open-trace/data.db, applies schema, enables WAL mode
getDb();

const app = express();
const token = loadToken(join(dirname(config.dbPath), 'token'));
const extraOrigins = (process.env.OPEN_TRACE_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean);
app.use(express.json({ limit: '10mb' }));

// API routes: guarded, CORS only for the dashboard and configured dev origins
app.use('/api', guard({ token, extraOrigins }), cors({ origin: [...DEV_ORIGINS, ...extraOrigins] }));
// The dashboard (same-origin or an allowed dev origin) fetches the token here; foreign pages are rejected by the guard.
app.get('/api/token', (_req, res) => res.json({ token }));
app.use('/api', apiRouter);

// Serve built dashboard if present (express.static is bundled with express)
const dashDist = resolve(process.env.DASHBOARD_DIST ?? join(__dirname, '..', 'dashboard', 'dist'));
if (existsSync(dashDist)) {
  app.use(express.static(dashDist));
  // SPA fallback: all non-API routes serve index.html
  app.get('/{*splat}', (_req, res) => res.sendFile(join(dashDist, 'index.html')));
}

// Start Express dashboard/API server
const server = createServer(app);
server.listen(config.daemonPort, '127.0.0.1', () => {
  const addr = 'http://' + 'localhost:' + server.address().port;
  console.log('[open-trace] Dashboard at ' + addr);
  console.log('[open-trace] DB: ' + config.dbPath);
});

// Start Claude Code intercepting proxy
createClaudeProxy(config.claudeProxyPort);

// Start OpenCode SQLite watcher
const ocWatcher = startOpenCodeWatcher();

const shutdown = () => { server.close(); ocWatcher?.close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

export default app;
