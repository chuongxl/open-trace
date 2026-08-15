import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { config } from './config.js';
import apiRouter from './api/router.js';
import { getDb } from './db/store.js';
import { createClaudeProxy } from './proxy/claude-proxy.js';
import { startOpenCodeWatcher } from './watchers/opencode-watcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Initialise DB at startup: creates ~/.open-trace/data.db, applies schema, enables WAL mode
getDb();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// API routes
app.use('/api', apiRouter);

// Serve built dashboard if present (express.static is bundled with express)
const dashDist = join(__dirname, '..', 'dashboard', 'dist');
if (existsSync(dashDist)) {
  app.use(express.static(dashDist));
  // SPA fallback: all non-API routes serve index.html
  app.get('*', (_req, res) => res.sendFile(join(dashDist, 'index.html')));
}

// Start Express dashboard/API server
const server = createServer(app);
server.listen(config.daemonPort, () => {
  const addr = 'http://' + 'localhost:' + config.daemonPort;
  console.log('[open-trace] Dashboard at ' + addr);
  console.log('[open-trace] DB: ' + config.dbPath);
});

// Start Claude Code intercepting proxy
createClaudeProxy(config.claudeProxyPort);

// Start OpenCode SQLite watcher
startOpenCodeWatcher();

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT',  () => { server.close(); process.exit(0); });

export default app;
