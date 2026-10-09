// Starts the dev infrastructure and then every app in watch mode.
//
//   pnpm dev          Postgres + Redis, then web/api/media on the host
//   pnpm dev:docker   same, but the media service runs in Docker (for hosts where the
//                     mediasoup worker cannot run natively)
//
// Postgres and Redis come from docker-compose when Docker is running. Without Docker,
// embedded instances are started instead (data in .dev/), so the project still runs with
// nothing but Node installed.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const dockerMedia = process.argv.includes('--docker-media');
const root = path.resolve(import.meta.dirname, '..');
const cleanup = [];

// With `shell: true` Node wants a single command string rather than an args array.
function run(command, options = {}) {
  return spawnSync(command, { stdio: 'inherit', shell: true, cwd: root, ...options });
}

function isListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A dev run that was killed instead of stopped can leave Postgres backends behind without
 * their postmaster: the port stays taken but nothing answers. Clears those out.
 */
async function removeOrphanedPostgres(databaseDir) {
  const pidFile = path.join(databaseDir, 'postmaster.pid');
  const pid = existsSync(pidFile) ? Number((await readFile(pidFile, 'utf8')).split('\n')[0]) : 0;
  // A live postmaster means a healthy instance from another terminal: leave it alone.
  if (pid && isAlive(pid)) return;
  if (!(await isListening(5432))) return;

  console.log('[dev] cleaning up a Postgres left over from an interrupted run');
  if (process.platform === 'win32') {
    run(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'postgres.exe\'\\" | ' +
        "Where-Object { $_.CommandLine -like '*embedded-postgres*' } | " +
        'ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"',
      { stdio: 'ignore' },
    );
  } else {
    run(`pkill -f "${databaseDir}"`, { stdio: 'ignore' });
  }
  await rm(pidFile, { force: true });
}

async function startEmbeddedPostgres() {
  const databaseDir = path.join(root, '.dev', 'postgres');
  await removeOrphanedPostgres(databaseDir);
  if (await isListening(5432)) {
    console.log('[dev] Postgres already listening on 5432');
    return;
  }
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  await mkdir(path.dirname(databaseDir), { recursive: true });
  const postgres = new EmbeddedPostgres({
    databaseDir,
    port: 5432,
    user: 'frequencia',
    password: 'frequencia',
    persistent: true,
    onLog: () => undefined,
    onError: () => undefined,
  });
  if (!existsSync(path.join(databaseDir, 'PG_VERSION'))) await postgres.initialise();
  await postgres.start();
  await postgres.createDatabase('frequencia').catch(() => undefined); // already exists
  cleanup.push(() => postgres.stop());
  console.log('[dev] embedded Postgres on 5432 (data in .dev/postgres)');
}

async function startEmbeddedRedis() {
  if (await isListening(6379)) {
    console.log('[dev] Redis already listening on 6379');
    return;
  }
  const { RedisMemoryServer } = await import('redis-memory-server');
  const redis = new RedisMemoryServer({ instance: { port: 6379 } });
  await redis.start();
  cleanup.push(() => redis.stop());
  console.log('[dev] embedded Redis on 6379 (in memory)');
}

const hasDocker = run('docker info', { stdio: 'ignore' }).status === 0;

if (hasDocker) {
  const services = dockerMedia ? 'postgres redis media' : 'postgres redis';
  const profile = dockerMedia ? '--profile media ' : '';
  const up = run(`docker compose ${profile}up -d --build --wait ${services}`);
  if (up.status !== 0) process.exit(up.status ?? 1);
  if (dockerMedia) {
    // Keeps the container sources in sync with the working tree.
    spawn('docker compose --profile media watch --no-up media', {
      stdio: 'ignore',
      shell: true,
      cwd: root,
    });
  }
} else if (dockerMedia) {
  console.error('[dev] --docker-media requires a running Docker daemon.');
  process.exit(1);
} else {
  console.log('[dev] Docker is not available: using embedded Postgres and Redis.');
  await startEmbeddedPostgres();
  await startEmbeddedRedis();
}

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
  for (const task of cleanup.reverse()) await task().catch(() => undefined);
  process.exit(code);
}
process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));
turbo.on('exit', (code) => void stop(code ?? 0));
