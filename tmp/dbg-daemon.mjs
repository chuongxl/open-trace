import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['daemon/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, DB_PATH: '/tmp/dbg.db', OPENCODE_DB_PATH: '/tmp/dbg-missing.db', DAEMON_PORT: '0', CLAUDE_PROXY_PORT: '0', COPILOT_PROXY_PORT: '0' },
  stdio: ['ignore','pipe','pipe'],
});
let out = '';
child.stdout.on('data', d => { out += d.toString(); });
child.stderr.on('data', d => { out += d.toString(); });
child.on('exit', (code, sig) => { console.log('=== DAEMON EXITED code=' + code + ' sig=' + sig + ' ==='); });
await new Promise(r => setTimeout(r, 4000));
console.log('=== DAEMON OUTPUT ===');
console.log(out);
const m = out.match(/localhost:(\d+)/);
if (m) {
  try { const res = await fetch('http://' + '127.0.0.1:' + m[1] + '/api/health'); console.log('=== FETCH OK === ' + res.status + ' ' + (await res.text())); }
  catch (e) { console.log('=== FETCH FAILED === ' + (e.cause ? e.cause.code : e.message)); }
} else { console.log('NO PORT MATCHED'); }
child.kill('SIGTERM');
process.exit(0);