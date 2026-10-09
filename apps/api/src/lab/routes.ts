import {
  LAB_VOICE_TOKEN_PATH,
  labVoiceTokenRequestSchema,
  P2P_SIGNALING_PATH,
  voiceTokenResponseSchema,
} from '@frequencia/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { buildIceServers } from '../lib/ice';
import { signVoiceToken } from '../modules/voice/voice-token';
import { P2pSignaling } from './p2p-signaling';

/**
 * Lab routes: the 1:1 P2P call and nickname-only voice rooms. They need no account, exist to
 * exercise the media stack in isolation, and are disabled in production (`LAB_ENABLED`).
 */
export const labRoutes: FastifyPluginAsyncZod = async (app) => {
  const { config } = app.ctx;
  const p2pSignaling = new P2pSignaling({
    iceServersFor: (peerId) => buildIceServers(config, peerId),
    log: app.log,
  });

  app.get(P2P_SIGNALING_PATH, { websocket: true, schema: { hide: true } }, (socket) =>
    p2pSignaling.accept(socket),
  );

  app.post(
    LAB_VOICE_TOKEN_PATH,
    {
      schema: {
        tags: ['lab'],
        summary: 'Voice token for a lab room, identified only by a nickname',
        body: labVoiceTokenRequestSchema,
        response: { 200: voiceTokenResponseSchema },
      },
    },
    async (request) => {
      const token = await signVoiceToken(
        {
          sub: `lab:${request.body.clientId}`,
          name: request.body.nickname,
          room: `lab:${request.body.channel}`,
          speak: true,
          stream: true,
        },
        { secret: config.MEDIA_SHARED_SECRET, ttlSeconds: config.VOICE_TOKEN_TTL_SECONDS },
      );
      return { token, iceServers: buildIceServers(config, `lab:${request.body.clientId}`) };
    },
  );
};
