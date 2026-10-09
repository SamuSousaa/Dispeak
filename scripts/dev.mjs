// Starts the dev infrastructure and then every app in watch mode.
//
//   pnpm dev          Postgres + Redis, then web/api/media on the host
//   pnpm dev:docker   same, but the media service runs in Docker (for hosts where the
//                     mediasoup worker cannot run natively)
import { spawn } from 'node:child_process';
import { root, startInfra } from './lib/infra.mjs';

const dockerMedia = process.argv.includes('--docker-media');
const stopInfra = await startInfra({ dockerMedia });

const filter = dockerMedia ? ' --filter=!@frequencia/media' : '';
const turbo = spawn(`pnpm exec turbo run dev${filter}`, {
  stdio: 'inherit',
  shell: true,
  cwd: root,
});

let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  turbo.kill();
  await stopInfra();
  process.exit(code);
}
process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));
turbo.on('exit', (code) => void stop(code ?? 0));
