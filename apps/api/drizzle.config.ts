import { defineConfig } from 'drizzle-kit';

// `pnpm --filter @frequencia/api db:generate` turns schema changes into a SQL migration.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://frequencia:frequencia@localhost:5432/frequencia',
  },
});
