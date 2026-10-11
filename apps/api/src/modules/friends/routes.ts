import {
  friendRequestsResponseSchema,
  guildSchema,
  idSchema,
  sendFriendRequestResponseSchema,
  sendFriendRequestSchema,
} from '@frequencia/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

/** Friend requests, and the end of a friendship. The conversations themselves are guilds. */
export const friendRoutes: FastifyPluginAsyncZod = async (app) => {
  const { friends } = app.ctx;
  const security = [{ bearerAuth: [] }];
  const requestParams = z.object({ requestId: idSchema });

  app.addHook('onRequest', app.authenticate);

  app.get(
    '/friends/requests',
    {
      schema: {
        tags: ['friends'],
        summary: 'Friend requests waiting for an answer, made to you or by you',
        security,
        response: { 200: friendRequestsResponseSchema },
      },
    },
    async (request) => ({ requests: await friends.listRequests(request.auth.userId) }),
  );

  app.post(
    '/friends/requests',
    {
      schema: {
        tags: ['friends'],
        summary: 'Ask someone to be your friend, by username',
        description:
          'When that person had already asked you, the conversation opens right away and is ' +
          'returned as `guild`.',
        security,
        body: sendFriendRequestSchema,
        response: { 200: sendFriendRequestResponseSchema },
      },
    },
    (request) => friends.request(request.auth.userId, request.body.username),
  );

  app.post(
    '/friends/requests/:requestId/accept',
    {
      schema: {
        tags: ['friends'],
        summary: 'Accept a request made to you',
        description: 'Opens the private conversation of the two: a guild of kind `dm`.',
        security,
        params: requestParams,
        response: { 200: guildSchema },
      },
    },
    (request) => friends.accept(request.auth.userId, request.params.requestId),
  );

  app.delete(
    '/friends/requests/:requestId',
    {
      schema: {
        tags: ['friends'],
        summary: 'Decline a request made to you, or withdraw one you made',
        security,
        params: requestParams,
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await friends.removeRequest(request.auth.userId, request.params.requestId);
      return reply.code(204).send(null);
    },
  );

  app.delete(
    '/friends/:userId',
    {
      schema: {
        tags: ['friends'],
        summary: 'End a friendship',
        description: 'Deletes the conversation of the two, with its messages, for both.',
        security,
        params: z.object({ userId: idSchema }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await friends.remove(request.auth.userId, request.params.userId);
      return reply.code(204).send(null);
    },
  );
};
