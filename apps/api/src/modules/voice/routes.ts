import { apiErrorSchema, idSchema, voiceTokenResponseSchema } from '@frequencia/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

export const voiceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/channels/:channelId/voice-token',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['voice'],
        summary: 'Short-lived token to join a voice channel on the media service (CONNECT)',
        description:
          'The token carries what the member may do in the channel (speak, stream) and is ' +
          'validated by the media service when the signaling WebSocket opens.',
        security: [{ bearerAuth: [] }],
        params: z.object({ channelId: idSchema }),
        response: { 200: voiceTokenResponseSchema, 403: apiErrorSchema, 404: apiErrorSchema },
      },
    },
    (request) => app.ctx.voice.issueToken(request.auth.userId, request.params.channelId),
  );
};
