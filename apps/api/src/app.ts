import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import {
  API_PREFIX,
  LAB_VOICE_TOKEN_PATH,
  labVoiceTokenRequestSchema,
  P2P_SIGNALING_PATH,
  type VoiceTokenResponse,
} from '@frequencia/shared';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { Config } from './config';
import { P2pSignaling } from './lab/p2p-signaling';
import { signVoiceToken } from './voice/voice-token';

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

  const iceServers = config.STUN_URLS.length > 0 ? [{ urls: config.STUN_URLS }] : [];
  const p2pSignaling = new P2pSignaling({ iceServers, log: app.log });

  await app.register(
    async (api) => {
      api.get('/health', async () => ({ status: 'ok', service: 'api', uptime: process.uptime() }));

      api.get(P2P_SIGNALING_PATH, { websocket: true }, (socket) => p2pSignaling.accept(socket));

      // Lab voice channels: anyone may join under a nickname. Replaced by authenticated,
      // permission-checked tokens once accounts exist.
      api.post(LAB_VOICE_TOKEN_PATH, async (request, reply): Promise<VoiceTokenResponse | void> => {
        const body = labVoiceTokenRequestSchema.safeParse(request.body);
        if (!body.success) {
          return reply.code(400).send({ error: 'invalid_request', message: 'invalid payload' });
        }
        const token = await signVoiceToken(
          {
            sub: `lab:${body.data.clientId}`,
            name: body.data.nickname,
            room: `lab:${body.data.channel}`,
            speak: true,
            stream: true,
          },
          { secret: config.MEDIA_SHARED_SECRET, ttlSeconds: config.VOICE_TOKEN_TTL_SECONDS },
        );
        return { token, iceServers };
      });
    },
    { prefix: API_PREFIX },
  );

  return app;
}
