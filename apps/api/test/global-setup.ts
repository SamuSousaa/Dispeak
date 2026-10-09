import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { TestProject } from 'vitest/node';
import { connectDatabase, runMigrations } from '../src/db/client';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Integration tests run against a real Postgres and a real Redis. CI provides them as
 * service containers (TEST_DATABASE_URL / TEST_REDIS_URL); otherwise throwaway embedded
 * instances are started, so `pnpm test` works on a machine without Docker.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const teardown: Array<() => Promise<unknown>> = [];

  let databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const databaseDir = await mkdtemp(path.join(os.tmpdir(), 'frequencia-pg-'));
    const port = await freePort();
    const postgres = new EmbeddedPostgres({
      databaseDir,
      port,
      user: 'frequencia',
      password: 'frequencia',
      persistent: false,
      onLog: () => undefined,
      onError: () => undefined,
    });
    await postgres.initialise();
    await postgres.start();
    await postgres.createDatabase('frequencia_test');
    teardown.push(async () => {
      await postgres.stop();
      await rm(databaseDir, { recursive: true, force: true });
    });
    databaseUrl = `postgres://frequencia:frequencia@127.0.0.1:${port}/frequencia_test`;
  }

  let redisUrl = process.env.TEST_REDIS_URL;
  if (!redisUrl) {
    const { RedisMemoryServer } = await import('redis-memory-server');
    const redis = new RedisMemoryServer();
    redisUrl = `redis://${await redis.getHost()}:${await redis.getPort()}`;
    teardown.push(() => redis.stop());
  }

  // Migrate once here; the apps under test start with RUN_MIGRATIONS=false.
  const database = connectDatabase(databaseUrl);
  await runMigrations(database.db);
  await database.close();

  project.provide('databaseUrl', databaseUrl);
  project.provide('redisUrl', redisUrl);

  return async () => {
    for (const stop of teardown.reverse()) await stop().catch(() => undefined);
  };
}
