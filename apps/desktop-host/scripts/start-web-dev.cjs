const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const backendPort = process.env.RIACORE_WEB_DEV_PORT || '5184';
const frontendPort = process.env.RIACORE_WEB_DEV_FRONTEND_PORT || '5183';
const backendHost = '127.0.0.1';
const frontendOrigin = `http://${backendHost}:${frontendPort}`;
const backendUrl = `http://${backendHost}:${backendPort}`;
const token = process.env.RIACORE_WEB_DEV_TOKEN || randomBytes(32).toString('hex');

const children = [];

function start(name, command, args, env) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    // On Windows, pnpm resolves to pnpm.cmd. Since the CVE-2024-27980 fix,
    // Node refuses to spawn .cmd/.bat files without a shell (throws EINVAL).
    shell: process.platform === 'win32',
  });
  children.push(child);
  child.stdout.on('data', (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM') {
      console.error(`[${name}] exited with code ${code ?? signal}`);
      shutdown(code || 1);
    }
  });
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('[web-dev] Starting browser-accessible RiaCore development mode');
console.log(`[web-dev] Frontend: ${frontendOrigin}`);
console.log(`[web-dev] Backend:  ${backendUrl}`);
console.log('[web-dev] Backend is loopback-only and protected by a per-run token.');

start('backend', 'node', ['apps/desktop-host/dist/web-dev-server.js'], {
  RIACORE_WEB_DEV: '1',
  RIACORE_WEB_DEV_HOST: backendHost,
  RIACORE_WEB_DEV_PORT: backendPort,
  RIACORE_WEB_DEV_TOKEN: token,
  RIACORE_WEB_DEV_ALLOWED_ORIGINS: `${frontendOrigin},http://localhost:${frontendPort}`,
});

start('renderer', pnpm, [
  '--filter',
  '@riacore/renderer',
  'dev',
  '--host',
  backendHost,
  '--port',
  frontendPort,
  '--strictPort',
], {
  VITE_RIACORE_WEB_DEV_URL: backendUrl,
  VITE_RIACORE_WEB_DEV_TOKEN: token,
});
