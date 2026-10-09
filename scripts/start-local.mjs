// Runs the production builds on this machine, without Docker:
//
//   pnpm build && pnpm start:local
//
// The API and the media service start from their bundles with NODE_ENV=production, and the
// built web app is served by `vite preview` with the same /api and /media proxying Caddy does
// in production. This is what the load tests run against, and a quick way to check that the
// production bundles actually boot.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { root, startInfra } from './lib/infra.mjs';

for (const bundle of ['apps/api/dist/index.js', 'apps/media/dist/index.js', 'apps/web/dist']) {
  if (!existsSync(path.join(root, bundle))) {
    console.error(`[start] ${bundle} is missing. Run "pnpm build" first.`);
    process.exit(1);
  }
}

// Local-only secrets: fine for a machine that is not reachable from the internet.
const secrets = {
  JWT_SECRET: 'local-jwt-secret-local-jwt-secret-local',
  MEDIA_SHARED_SECRET: 'local-media-secret-local-media-secret',
};
const env = {
  ...process.env,
  NODE_ENV: 'production',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  COOKIE_SECURE: 'false', // served over plain http://localhost
  ...secrets,
};

const stopInfra = await startInfra();
const children = [
  ['api', 'node dist/index.js', 'apps/api'],
  ['media', 'node dist/index.js', 'apps/media'],
  ['web', 'pnpm exec vite preview', 'apps/web'],
].map(([name, command, cwd]) => {
  const child = spawn(command, { stdio: 'inherit', shell: true, cwd: path.join(root, cwd), env });
  child.on('exit', (code) => {
    console.error(`[start] ${name} exited with code ${code}`);
    void stop(code ?? 1);
  });
  return child;
});
console.log('[start] production builds running at http://localhost:5173');

let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  await stopInfra();
  process.exit(code);
}
process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));
