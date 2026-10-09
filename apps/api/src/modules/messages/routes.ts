import {
  editMessageRequestSchema,
  idSchema,
  listMessagesQuerySchema,
  messagePageSchema,
  messageSchema,
  sendMessageRequestSchema,
} from '@frequencia/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

const channelParams = z.object({ channelId: idSchema });
const messageParams = z.object({ messageId: idSchema });
const noContent = { 204: z.null() };

/**
 * Subject of the bearer token, read without verifying it. Rate limiting runs before
 * authentication, and a forged subject only earns a 401 from the next hook.
 */
function tokenSubject(request: FastifyRequest): string | null {
  const payload = request.headers.authorization?.split('.')[1];
  if (!payload) return null;
  try {
    const { sub } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { sub?: unknown };
    return typeof sub === 'string' ? `user:${sub}` : null;
  } catch {
    return null;
  }
}

export const messageRoutes: FastifyPluginAsyncZod = async (app) => {
  const { messages, config } = app.ctx;
  const security = [{ bearerAuth: [] }];
  app.addHook('onRequest', app.authenticate);

  app.get(
    '/channels/:channelId/messages',
    {
      schema: {
        tags: ['messages'],
        summary: 'Message history, newest page first, paginated by cursor',
        description:
          'Returns up to `limit` messages in chronological order. Pass the returned ' +
          '`nextCursor` as `before` to load the previous page.',
        security,
        params: channelParams,
        querystring: listMessagesQuerySchema,
        response: { 200: messagePageSchema },
      },
    },
    (request) => messages.list(request.auth.userId, request.params.channelId, request.query),
  );

  app.post(
    '/channels/:channelId/messages',
    {
      // Chat is the easiest endpoint to spam. The limit is per user, not per address, so
      // friends behind the same router do not share a budget.
      config: {
        rateLimit: {
          max: config.RATE_LIMIT_MESSAGES_MAX,
          timeWindow: '1 minute',
          keyGenerator: (request: FastifyRequest) => tokenSubject(request) ?? request.ip,
        },
      },
      schema: {
        tags: ['messages'],
        summary: 'Send a message (SEND_MESSAGES)',
        description: 'Mention a member with `<@user-id>`; `@todos` mentions everyone.',
        security,
        params: channelParams,
        body: sendMessageRequestSchema,
        response: { 201: messageSchema },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await messages.send(request.auth.userId, request.params.channelId, request.body.content),
        ),
  );

  app.post(
    '/channels/:channelId/typing',
    {
      schema: {
        tags: ['messages'],
        summary: 'Tell the channel the user is typing',
        security,
        params: channelParams,
        response: noContent,
      },
    },
    async (request, reply) => {
      await messages.typing(request.auth.userId, request.params.channelId);
      return reply.code(204).send(null);
    },
  );

  app.patch(
    '/messages/:messageId',
    {
      schema: {
        tags: ['messages'],
        summary: 'Edit your own message',
        security,
        params: messageParams,
        body: editMessageRequestSchema,
        response: { 200: messageSchema },
      },
    },
    (request) => messages.edit(request.auth.userId, request.params.messageId, request.body.content),
  );

  app.delete(
    '/messages/:messageId',
    {
      schema: {
        tags: ['messages'],
        summary: 'Delete your own message, or any message with MANAGE_MESSAGES',
        security,
        params: messageParams,
        response: noContent,
      },
    },
    async (request, reply) => {
      await messages.delete(request.auth.userId, request.params.messageId);
      return reply.code(204).send(null);
    },
  );
};
