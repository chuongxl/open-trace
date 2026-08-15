import { homedir } from 'os';
import { join } from 'path';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

function resolvePath(p) {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

export const config = {
  daemonPort:      parseInt(process.env.DAEMON_PORT      ?? '9900'),
  claudeProxyPort: parseInt(process.env.CLAUDE_PROXY_PORT ?? '9876'),
  copilotProxyPort: parseInt(process.env.COPILOT_PROXY_PORT ?? '9877'),
  dbPath:          resolvePath(process.env.DB_PATH ?? '~/.open-trace/data.db'),
  openCodeDbPath:  resolvePath(process.env.OPENCODE_DB_PATH
                   ?? '~/.local/share/opencode/opencode.db'),
  anthropicTarget: 'https://api.anthropic.com',
  version:         '0.1.0',
};
