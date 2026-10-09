import { DEFAULT_API_PORT } from '@frequencia/shared';
import { z } from 'zod';

const csv = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(0).max(65535).default(DEFAULT_API_PORT),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: csv.default(['http://localhost:5173']),
  /** STUN servers handed to browsers for NAT traversal. */
  STUN_URLS: csv.default(['stun:stun.l.google.com:19302']),
  /** Secret shared with the media service: signs voice tokens and authenticates internal RPC. */
  MEDIA_SHARED_SECRET: z.string().min(32).optional(),
  VOICE_TOKEN_TTL_SECONDS: z.coerce.number().int().min(5).max(600).default(60),
});

const DEV_SHARED_SECRET = 'dev-media-shared-secret-change-me';

export type Config = Omit<z.infer<typeof envSchema>, 'MEDIA_SHARED_SECRET'> & {
  MEDIA_SHARED_SECRET: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${z.prettifyError(parsed.error)}`);
  }
  const data = parsed.data;
  if (data.NODE_ENV === 'production' && !data.MEDIA_SHARED_SECRET) {
    throw new Error('MEDIA_SHARED_SECRET is required in production');
  }
  return { ...data, MEDIA_SHARED_SECRET: data.MEDIA_SHARED_SECRET ?? DEV_SHARED_SECRET };
}
