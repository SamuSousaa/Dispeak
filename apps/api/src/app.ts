import cors from '@fastify/cors';
import { API_PREFIX } from '@frequencia/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config';

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    disableRequestLogging: true,
    logger:
      config.NODE_ENV === 'test'
        ? false
        : {
            level: config.LOG_LEVEL,
            ...(config.NODE_ENV === 'development'
              ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
              : {}),
          },
  });

  await app.register(cors, { origin: config.CORS_ORIGINS, credentials: true });

  await app.register(
    async (api) => {
      api.get('/health', async () => ({ status: 'ok', service: 'api', uptime: process.uptime() }));
    },
    { prefix: API_PREFIX },
  );

  return app;
}
