import { apiErrorSchema, blockListSchema, guildSchema, idSchema } from '@frequencia/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

/** Private conversations with anyone (not only friends), message requests and blocking. */
export const conversationRoutes: FastifyPluginAsyncZod = async (app) => {
  const { conversations } = app.ctx;
  const security = [{ bearerAuth: [] }];
  const userParams = z.object({ userId: idSchema });
  const guildParams = z.object({ guildId: idSchema });

  app.addHook('onRequest', app.authenticate);

  app.post(
    '/users/:userId/conversation',
    {
      schema: {
        tags: ['conversations'],
        summary: 'The private conversation with someone, started if there is none',
        description:
          'Friends always have one. Otherwise the two must share a server and the other must ' +
          'not keep a private profile (`dm_closed`); a block either way refuses it (`blocked`). ' +
          'A new conversation with someone who is not a friend is a message request: they see ' +
          'it after the first message, and accept or decline it.',
        security,
        params: userParams,
        response: { 200: guildSchema, 403: apiErrorSchema, 404: apiErrorSchema },
      },
    },
    (request) => conversations.open(request.auth.userId, request.params.userId),
  );

  app.post(
    '/conversations/:guildId/accept',
    {
      schema: {
        tags: ['conversations'],
        summary: 'Accept a message request',
        description: 'Answering in the conversation accepts it too.',
        security,
        params: guildParams,
        response: { 204: z.null(), 404: apiErrorSchema },
      },
    },
    async (request, reply) => {
      await conversations.accept(request.auth.userId, request.params.guildId);
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/conversations/:guildId/decline',
    {
      schema: {
        tags: ['conversations'],
        summary: 'Decline a message request',
        description: 'It disappears for you; the person who sent it is not told.',
        security,
        params: guildParams,
        response: { 204: z.null(), 404: apiErrorSchema },
      },
    },
    async (request, reply) => {
      await conversations.decline(request.auth.userId, request.params.guildId);
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/users/@me/blocks',
    {
      schema: {
        tags: ['conversations'],
        summary: 'The people you block',
        security,
        response: { 200: blockListSchema },
      },
    },
    async (request) => ({ users: await conversations.listBlocks(request.auth.userId) }),
  );

  app.put(
    '/users/@me/blocks/:userId',
    {
      schema: {
        tags: ['conversations'],
        summary: 'Block someone',
        description:
          'Ends the friendship and any friend request between you; your conversation stays, ' +
          'but nothing can be sent or called in it until you unblock them.',
        security,
        params: userParams,
        response: { 204: z.null(), 404: apiErrorSchema },
      },
    },
    async (request, reply) => {
      await conversations.block(request.auth.userId, request.params.userId);
      return reply.code(204).send(null);
    },
  );

  app.delete(
    '/users/@me/blocks/:userId',
    {
      schema: {
        tags: ['conversations'],
        summary: 'Unblock someone',
        security,
        params: userParams,
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await conversations.unblock(request.auth.userId, request.params.userId);
      return reply.code(204).send(null);
    },
  );
};
