// Postgres and Redis for local runs. Docker is used when it is running; otherwise embedded
// instances are started (data in .dev/), so the project works with nothing but Node installed.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

export const root = path.resolve(import.meta.dirname, '..', '..');

// With `shell: true` Node wants a single command string rather than an args array.
export function run(command, options = {}) {
  return spawnSync(command, { stdio: 'inherit', shell: true, cwd: root, ...options });
}

export function isListening(port) {
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
 * A run that was killed instead of stopped can leave Postgres backends behind without their
 * postmaster: the port stays taken but nothing answers. Clears those out.
 */
async function removeOrphanedPostgres(databaseDir) {
  const pidFile = path.join(databaseDir, 'postmaster.pid');
  const pid = existsSync(pidFile) ? Number((await readFile(pidFile, 'utf8')).split('\n')[0]) : 0;
  // A live postmaster means a healthy instance from another terminal: leave it alone.
  if (pid && isAlive(pid)) return;
  if (!(await isListening(5432))) return;

  console.log('[infra] cleaning up a Postgres left over from an interrupted run');
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

async function startEmbeddedPostgres(cleanup) {
  const databaseDir = path.join(root, '.dev', 'postgres');
  await removeOrphanedPostgres(databaseDir);
  if (await isListening(5432)) {
    console.log('[infra] Postgres already listening on 5432');
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
    // Without this, initdb on Windows picks the system code page (WIN1252), which cannot
    // store emoji. Only applies to a new cluster: an old one must be deleted or converted.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => undefined,
    onError: () => undefined,
  });
  if (!existsSync(path.join(databaseDir, 'PG_VERSION'))) await postgres.initialise();
  await postgres.start();
  await postgres.createDatabase('frequencia').catch(() => undefined); // already exists
  cleanup.push(() => postgres.stop());
  console.log('[infra] embedded Postgres on 5432 (data in .dev/postgres)');
}

async function startEmbeddedRedis(cleanup) {
  if (await isListening(6379)) {
    console.log('[infra] Redis already listening on 6379');
    return;
  }
  const { RedisMemoryServer } = await import('redis-memory-server');
  const redis = new RedisMemoryServer({ instance: { port: 6379 } });
  await redis.start();
  cleanup.push(() => redis.stop());
  console.log('[infra] embedded Redis on 6379 (in memory)');
}

/**
 * Makes Postgres (5432) and Redis (6379) available and resolves with a function that stops
 * whatever this call started. With `dockerMedia` the media service container is started too.
 */
export async function startInfra({ dockerMedia = false } = {}) {
  const cleanup = [];
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
    console.error('[infra] --docker-media requires a running Docker daemon.');
    process.exit(1);
  } else {
    console.log('[infra] Docker is not available: using embedded Postgres and Redis.');
    await startEmbeddedPostgres(cleanup);
    await startEmbeddedRedis(cleanup);
  }

  return async () => {
    for (const task of cleanup.reverse()) await task().catch(() => undefined);
  };
}
