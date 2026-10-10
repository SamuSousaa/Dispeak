import {
  IMAGE_CONTENT_TYPES,
  ATTACHMENT_MAX_BYTES,
  attachmentSchema,
  editMessageRequestSchema,
  idSchema,
  listMessagesQuerySchema,
  messagePageSchema,
  messageSchema,
  reactionEmojiSchema,
  sendMessageRequestSchema,
  unreadResponseSchema,
  votePollRequestSchema,
  uploadAttachmentQuerySchema,
} from '@frequencia/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { badRequest } from '../../errors';
import { perUser } from '../../lib/per-user-limit';

const channelParams = z.object({ channelId: idSchema });
const messageParams = z.object({ messageId: idSchema });
const reactionParams = z.object({ messageId: idSchema, emoji: reactionEmojiSchema });
const attachmentParams = z.object({ attachmentId: idSchema });
const noContent = { 204: z.null() };

export const messageRoutes: FastifyPluginAsyncZod = async (app) => {
  const { messages, config } = app.ctx;
  const security = [{ bearerAuth: [] }];
  app.addHook('onRequest', app.authenticate);

  // Uploads arrive as the raw bytes of one image; these parsers exist only inside this plugin.
  app.addContentTypeParser(
    // The declared type is not trusted either way: images are recognised from their bytes.
    [...IMAGE_CONTENT_TYPES, 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: ATTACHMENT_MAX_BYTES },
    (_request, body, done) => done(null, body),
  );

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
          'takes ids returned by the upload endpoint of the same channel. `replyToId` makes ' +
          'the message an answer to another one of the channel.',
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
            request.body.replyToId,
            request.body.poll,
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
        summary: 'Upload a file to attach to the next message (SEND_MESSAGES, ATTACH_FILES)',
        description:
          'The body is the raw file, up to 25 MiB, sent as `application/octet-stream`. PNG, ' +
          'JPEG, GIF and WebP are recognised from their bytes and shown as images; anything ' +
          'else is only offered for download. An upload not used in a message within an hour ' +
          'is discarded.',
        security,
        consumes: ['application/octet-stream', ...IMAGE_CONTENT_TYPES],
        params: channelParams,
        querystring: uploadAttachmentQuerySchema,
        response: { 201: attachmentSchema },
      },
    },
    async (request, reply) => {
      if (!Buffer.isBuffer(request.body)) throw badRequest('the body must be a file');
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
      const isImage = (IMAGE_CONTENT_TYPES as readonly string[]).includes(attachment.contentType);
      return (
        reply
          .header('content-type', isImage ? attachment.contentType : 'application/octet-stream')
          .header('content-length', attachment.size)
          .header(
            'content-disposition',
            // Only pictures are ever rendered by a browser; any other file is saved to disk.
            `${isImage ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
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

  app.put(
    '/messages/:messageId/poll/votes',
    {
      config: perUser(config.RATE_LIMIT_MESSAGES_MAX),
      schema: {
        tags: ['messages'],
        summary: 'Vote in the poll of a message (VIEW_CHANNEL)',
        description: 'Replaces the previous vote of the user; an empty list takes it back.',
        security,
        params: messageParams,
        body: votePollRequestSchema,
        response: { 200: messageSchema },
      },
    },
    (request) =>
      messages.vote(request.auth.userId, request.params.messageId, request.body.optionIds),
  );

  app.put(
    '/messages/:messageId/reactions/:emoji',
    {
      config: perUser(config.RATE_LIMIT_MESSAGES_MAX),
      schema: {
        tags: ['messages'],
        summary: 'React to a message with an emoji (VIEW_CHANNEL)',
        security,
        params: reactionParams,
        response: { 200: messageSchema },
      },
    },
    (request) =>
      messages.react(request.auth.userId, request.params.messageId, request.params.emoji),
  );

  app.delete(
    '/messages/:messageId/reactions/:emoji',
    {
      schema: {
        tags: ['messages'],
        summary: 'Take back your own reaction',
        security,
        params: reactionParams,
        response: { 200: messageSchema },
      },
    },
    (request) =>
      messages.unreact(request.auth.userId, request.params.messageId, request.params.emoji),
  );

  app.get(
    '/users/@me/unread',
    {
      schema: {
        tags: ['messages'],
        summary: 'Channels with messages the user has not read yet',
        security,
        response: { 200: unreadResponseSchema },
      },
    },
    async (request) => ({ channels: await messages.unread(request.auth.userId) }),
  );

  app.post(
    '/channels/:channelId/ack',
    {
      schema: {
        tags: ['messages'],
        summary: 'Mark a channel as read up to now',
        security,
        params: channelParams,
        response: noContent,
      },
    },
    async (request, reply) => {
      await messages.ack(request.auth.userId, request.params.channelId);
      return reply.code(204).send(null);
    },
  );
};
