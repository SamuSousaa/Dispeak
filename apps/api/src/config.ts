import { DEFAULT_API_PORT } from '@frequencia/shared';
import { z } from 'zod';

const csv = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

const flag = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const DEV_MEDIA_SECRET = 'dev-media-shared-secret-change-me';
const DEV_JWT_SECRET = 'dev-jwt-secret-change-me-dev-jwt-secret';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(0).max(65535).default(DEFAULT_API_PORT),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: csv.default(['http://localhost:5173']),

  DATABASE_URL: z.string().default('postgres://frequencia:frequencia@localhost:5432/frequencia'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  /** Apply pending SQL migrations on startup. */
  RUN_MIGRATIONS: flag.default(true),

  /** Signs access tokens. */
  JWT_SECRET: z.string().min(32).optional(),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(1).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** Send the refresh cookie only over HTTPS. Defaults to on in production. */
  COOKIE_SECURE: flag.optional(),

  /** STUN servers handed to browsers for NAT traversal. */
  STUN_URLS: csv.default(['stun:stun.l.google.com:19302']),
  /** Secret shared with the media service: signs voice tokens and authenticates internal RPC. */
  MEDIA_SHARED_SECRET: z.string().min(32).optional(),
  /** Internal WebSocket endpoint of the media service. */
  MEDIA_INTERNAL_URL: z.string().default('ws://localhost:4100/media/internal'),
  VOICE_TOKEN_TTL_SECONDS: z.coerce.number().int().min(5).max(600).default(60),

  /** Requests per minute allowed per client, and the stricter limit for auth endpoints. */
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().min(1).default(20),
  /** Messages per minute a single user may send. */
  RATE_LIMIT_MESSAGES_MAX: z.coerce.number().int().min(1).default(60),

  GATEWAY_HEARTBEAT_MS: z.coerce.number().int().min(50).default(30_000),
  /** How long a dropped gateway session can still be resumed. */
  GATEWAY_RESUME_WINDOW_MS: z.coerce.number().int().min(0).default(60_000),
  /** Gateway frames a connection may send per 10 seconds. */
  GATEWAY_RATE_LIMIT: z.coerce.number().int().min(1).default(60),

  /** Nickname-only lab routes (`/lab/*`). Off by default in production. */
  LAB_ENABLED: flag.optional(),
});

type Env = z.infer<typeof envSchema>;

export type Config = Omit<
  Env,
  'MEDIA_SHARED_SECRET' | 'JWT_SECRET' | 'COOKIE_SECURE' | 'LAB_ENABLED'
> & {
  MEDIA_SHARED_SECRET: string;
  JWT_SECRET: string;
  COOKIE_SECURE: boolean;
  LAB_ENABLED: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${z.prettifyError(parsed.error)}`);
  }
  const data = parsed.data;
  const production = data.NODE_ENV === 'production';

  if (production) {
    for (const name of ['MEDIA_SHARED_SECRET', 'JWT_SECRET'] as const) {
      if (!data[name]) throw new Error(`${name} is required in production`);
    }
  }

  return {
    ...data,
    MEDIA_SHARED_SECRET: data.MEDIA_SHARED_SECRET ?? DEV_MEDIA_SECRET,
    JWT_SECRET: data.JWT_SECRET ?? DEV_JWT_SECRET,
    COOKIE_SECURE: data.COOKIE_SECURE ?? production,
    LAB_ENABLED: data.LAB_ENABLED ?? !production,
  };
}
