// Local API guard: browsers can reach 127.0.0.1, so any web page could read this API
// (CORS-less GETs, DNS rebinding) or call mutating endpoints. Three checks:
//   1. Host must be a loopback name on the port we listen on (blocks DNS rebinding).
//   2. A browser Origin must be this dashboard or a configured dev origin (blocks cross-site calls).
//   3. Mutating methods need the per-install bearer token (blocks anything that is not the dashboard or a local tool).
import { randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
export const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

/** Read the install token, creating it (mode 0600) on first run. */
export function loadToken(path) {
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  mkdirSync(dirname(path), { recursive: true });
  const token = randomBytes(32).toString('hex');
  writeFileSync(path, token + '\n', { mode: 0o600 });
  return token;
}

function sameToken(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function guard({ token, extraOrigins = [] }) {
  const devOrigins = new Set([...DEV_ORIGINS, ...extraOrigins]);
  const hosts = (port) => new Set(LOOPBACK.map((h) => `${h}:${port}`));

  return (req, res, next) => {
    const port = req.socket.localPort;
    if (!hosts(port).has(req.headers.host)) return res.status(403).json({ error: 'Forbidden host' });

    const origin = req.headers.origin;
    if (origin && !devOrigins.has(origin) && !hosts(port).has(origin.replace(/^https?:\/\//, ''))) {
      return res.status(403).json({ error: 'Forbidden origin' });
    }

    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const given = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!sameToken(given, token)) return res.status(401).json({ error: 'Missing or invalid token' });
    }
    next();
  };
}
