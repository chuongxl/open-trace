import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { config } from './config.js';
import apiRouter from './api/router.js';
import { getDb } from './db/store.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
getDb();
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/api', apiRouter);
const dashDist = join(__dirname, '..', 'dashboard', 'dist');
if (existsSync(dashDist)) {
  app.use(express.static(dashDist));
  app.get('*', (_req, res) => res.sendFile(join(dashDist, 'index.html')));
}
const server = createServer(app);
server.listen(config.daemonPort, () => {
  const addr = 'http://' + 'localhost:' + config.daemonPort;
  console.log('[open-trace] running at ' + addr);
  console.log('[open-trace] claude proxy port ' + config.claudeProxyPort);
  console.log('[open-trace] db ' + config.dbPath);
});
process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT',  () => { server.close(); process.exit(0); });
export default app;