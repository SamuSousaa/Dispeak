import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { API_PREFIX, P2P_SIGNALING_PATH } from '@frequencia/shared';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { Config } from './config';
import { P2pSignaling } from './lab/p2p-signaling';

const WS_MAX_PAYLOAD_BYTES = 256 * 1024;

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
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
  await app.register(websocket, { options: { maxPayload: WS_MAX_PAYLOAD_BYTES } });

  const p2pSignaling = new P2pSignaling({
    iceServers: config.STUN_URLS.length > 0 ? [{ urls: config.STUN_URLS }] : [],
    log: app.log,
  });

  await app.register(
    async (api) => {
      api.get('/health', async () => ({ status: 'ok', service: 'api', uptime: process.uptime() }));

      api.get(P2P_SIGNALING_PATH, { websocket: true }, (socket) => p2pSignaling.accept(socket));
    },
    { prefix: API_PREFIX },
  );

  return app;
}
