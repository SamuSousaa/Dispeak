import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './schema';

export type Database = PostgresJsDatabase<typeof schema>;
/** A database handle or an open transaction: anything queries can run on. */
export type Queryable = Pick<Database, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

export interface DatabaseHandle {
  db: Database;
  close: () => Promise<void>;
}

export function connectDatabase(url: string, poolSize = 10): DatabaseHandle {
  const client = postgres(url, { max: poolSize, onnotice: () => undefined });
  return {
    db: drizzle(client, { schema }),
    close: () => client.end({ timeout: 5 }),
  };
}

/** The SQL migrations ship next to the sources in dev and next to the bundle in production. */
function migrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of ['../drizzle', '../../drizzle', './drizzle']) {
    const folder = path.resolve(here, candidate);
    if (existsSync(path.join(folder, 'meta', '_journal.json'))) return folder;
  }
  throw new Error('migrations folder not found');
}

export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: migrationsFolder() });
}

export { schema };
