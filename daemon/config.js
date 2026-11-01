import { homedir } from 'os';
import { join } from 'path';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

function resolvePath(p) {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

const num = (name, dflt) => { const v = Number(process.env[name]); return process.env[name] !== undefined && Number.isFinite(v) ? v : dflt; };

export const config = {
  daemonPort:      parseInt(process.env.DAEMON_PORT      ?? '9900'),
  claudeProxyPort: parseInt(process.env.CLAUDE_PROXY_PORT ?? '9876'),
  copilotProxyPort: parseInt(process.env.COPILOT_PROXY_PORT ?? '9877'),
  dbPath:          resolvePath(process.env.DB_PATH ?? '~/.open-trace/data.db'),
  openCodeDbPath:  resolvePath(process.env.OPENCODE_DB_PATH
                   ?? '~/.local/share/opencode/opencode.db'),
  anthropicTarget: 'https://api.anthropic.com',
  // Stuck-agent detectors (13c). 0 disables a detector.
  detectors: {
    repeatCalls:         num('DETECT_REPEAT_CALLS', 3),      // same tool + same input, N in a row
    repeatErrors:        num('DETECT_REPEAT_ERRORS', 3),     // same failing tool result, N times in the last 20 calls
    contextPct:          num('DETECT_CONTEXT_PCT', 80),      // % of the context window
    contextWindowTokens: num('CONTEXT_WINDOW_TOKENS', 200000),
    costUsd:             num('DETECT_COST_USD', 5),          // session equiv. cost
  },
  // Privacy (#64). REDACT=0 turns redaction off; REDACT_PATTERNS is a JSON array of extra regex sources.
  redaction: {
    enabled: process.env.REDACT !== '0',
    extraPatterns: (() => {
      try { const v = JSON.parse(process.env.REDACT_PATTERNS ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; }
      catch { console.warn('[config] REDACT_PATTERNS is not valid JSON; ignoring it'); return []; }
    })(),
  },
  // Delete prompts, tool calls and sessions older than this many days. 0 (default) keeps everything.
  retentionDays: num('RETENTION_DAYS', 0),
  version:         '0.1.0',
};
