// Starts the dev infrastructure and then every app in watch mode.
//
//   pnpm dev          Postgres + Redis in Docker, web/api/media on the host
//   pnpm dev:docker   same, but the media service also runs in Docker (needed when the
//                     mediasoup worker cannot run natively on the host)
//
// Without Docker the apps still start; Postgres and Redis must then be reachable through
// DATABASE_URL / REDIS_URL (see README).
import { spawn, spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';
const dockerMedia = process.argv.includes('--docker-media');

function docker(args, options = {}) {
  return spawnSync('docker', args, { stdio: 'inherit', shell: isWindows, ...options });
}

const hasDocker = docker(['info'], { stdio: 'ignore' }).status === 0;

if (hasDocker) {
  const services = dockerMedia ? ['postgres', 'redis', 'media'] : ['postgres', 'redis'];
  const profile = dockerMedia ? ['--profile', 'media'] : [];
  const up = docker(['compose', ...profile, 'up', '-d', '--build', '--wait', ...services]);
  if (up.status !== 0) process.exit(up.status ?? 1);
  if (dockerMedia) {
    // Keeps the container sources in sync with the working tree.
    spawn('docker', ['compose', '--profile', 'media', 'watch', '--no-up', 'media'], {
      stdio: 'ignore',
      shell: isWindows,
    });
  }
} else if (dockerMedia) {
  console.error('[dev] --docker-media requires a running Docker daemon.');
  process.exit(1);
} else {
  console.warn('[dev] Docker is not available: skipping the Postgres/Redis containers.');
}

const filter = dockerMedia ? ['--filter=!@frequencia/media'] : [];
const turbo = spawn('pnpm', ['exec', 'turbo', 'run', 'dev', ...filter], {
  stdio: 'inherit',
  shell: isWindows,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => turbo.kill(signal));
}
turbo.on('exit', (code) => process.exit(code ?? 0));
