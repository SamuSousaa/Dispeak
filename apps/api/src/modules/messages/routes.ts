import {
  ATTACHMENT_CONTENT_TYPES,
  ATTACHMENT_MAX_BYTES,
  attachmentSchema,
  editMessageRequestSchema,
  idSchema,
  listMessagesQuerySchema,
  messagePageSchema,
  messageSchema,
  sendMessageRequestSchema,
  uploadAttachmentQuerySchema,
} from '@frequencia/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { badRequest } from '../../errors';

const channelParams = z.object({ channelId: idSchema });
const messageParams = z.object({ messageId: idSchema });
const attachmentParams = z.object({ attachmentId: idSchema });
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

  // Uploads arrive as the raw bytes of one image; these parsers exist only inside this plugin.
  app.addContentTypeParser(
    [...ATTACHMENT_CONTENT_TYPES],
    { parseAs: 'buffer', bodyLimit: ATTACHMENT_MAX_BYTES },
    (_request, body, done) => done(null, body),
  );
  const perUser = (max: number) => ({
    rateLimit: {
      max,
      timeWindow: '1 minute',
      keyGenerator: (request: FastifyRequest) => tokenSubject(request) ?? request.ip,
    },
  });

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
      config: perUser(config.RATE_LIMIT_MESSAGES_MAX),
      schema: {
        tags: ['messages'],
        summary: 'Send a message (SEND_MESSAGES)',
        description:
          'Mention a member with `<@user-id>`; `@todos` mentions everyone. `attachmentIds` ' +
          'takes ids returned by the upload endpoint of the same channel.',
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
          await messages.send(
            request.auth.userId,
            request.params.channelId,
            request.body.content,
            request.body.attachmentIds,
          ),
        ),
  );

  app.post(
    '/channels/:channelId/attachments',
    {
      bodyLimit: ATTACHMENT_MAX_BYTES,
      config: perUser(config.RATE_LIMIT_UPLOADS_MAX),
      schema: {
        tags: ['messages'],
        summary: 'Upload an image to attach to the next message (SEND_MESSAGES)',
        description:
          'The body is the raw file (PNG, JPEG, GIF or WebP, up to 8 MiB) with a matching ' +
          '`Content-Type`. The type is verified from the bytes. An upload not used in a ' +
          'message within an hour is discarded.',
        security,
        consumes: [...ATTACHMENT_CONTENT_TYPES],
        params: channelParams,
        querystring: uploadAttachmentQuerySchema,
        response: { 201: attachmentSchema },
      },
    },
    async (request, reply) => {
      if (!Buffer.isBuffer(request.body)) throw badRequest('the body must be an image');
      return reply
        .code(201)
        .send(
          await messages.upload(
            request.auth.userId,
            request.params.channelId,
            request.query.filename,
            request.body,
          ),
        );
    },
  );

  app.get(
    '/attachments/:attachmentId',
    {
      schema: {
        tags: ['messages'],
        summary: 'Download an attachment (VIEW_CHANNEL on its channel)',
        security,
        params: attachmentParams,
      },
    },
    async (request, reply) => {
      const { attachment, stream } = await messages.download(
        request.auth.userId,
        request.params.attachmentId,
      );
      return (
        reply
          .header('content-type', attachment.contentType)
          .header('content-length', attachment.size)
          .header(
            'content-disposition',
            `inline; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
          )
          // The bytes behind an id never change, and they are only ever this user's to cache.
          .header('cache-control', 'private, max-age=31536000, immutable')
          .header('x-content-type-options', 'nosniff')
          .header('content-security-policy', "default-src 'none'; sandbox")
          .send(stream)
      );
    },
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
