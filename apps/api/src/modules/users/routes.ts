import {
  idSchema,
  PICTURE_MAX_BYTES,
  selfSchema,
  updateProfileRequestSchema,
} from '@frequencia/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { badRequest, notFound } from '../../errors';
import { perUser } from '../../lib/per-user-limit';

/** Profile pictures, and the address every picture (avatar or server icon) is served from. */
export const userRoutes: FastifyPluginAsyncZod = async (app) => {
  const { users, pictures, config } = app.ctx;
  const security = [{ bearerAuth: [] }];

  // Uploads arrive as the raw bytes of the image.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: PICTURE_MAX_BYTES },
    (_request, body, done) => done(null, body),
  );

  app.put(
    '/users/@me/avatar',
    {
      onRequest: [app.authenticate],
      bodyLimit: PICTURE_MAX_BYTES,
      config: perUser(config.RATE_LIMIT_UPLOADS_MAX),
      schema: {
        tags: ['users'],
        summary: 'Set your profile picture',
        description:
          'The body is the raw image (PNG, JPEG, GIF or WebP, up to 1 MiB) sent as ' +
          '`application/octet-stream`. Clients are expected to send a small square picture.',
        security,
        consumes: ['application/octet-stream'],
        response: { 200: selfSchema },
      },
    },
    (request) => {
      if (!Buffer.isBuffer(request.body)) throw badRequest('the body must be an image');
      return users.setAvatar(request.auth.userId, request.body);
    },
  );

  app.delete(
    '/users/@me/avatar',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['users'],
        summary: 'Remove your profile picture',
        security,
        response: { 200: selfSchema },
      },
    },
    (request) => users.setAvatar(request.auth.userId, null),
  );

  app.put(
    '/users/@me/banner',
    {
      onRequest: [app.authenticate],
      bodyLimit: PICTURE_MAX_BYTES,
      config: perUser(config.RATE_LIMIT_UPLOADS_MAX),
      schema: {
        tags: ['users'],
        summary: 'Set the picture on top of your profile card',
        description: 'Same format as the profile picture; clients send a wide image.',
        security,
        consumes: ['application/octet-stream'],
        response: { 200: selfSchema },
      },
    },
    (request) => {
      if (!Buffer.isBuffer(request.body)) throw badRequest('the body must be an image');
      return users.setBanner(request.auth.userId, request.body);
    },
  );

  app.delete(
    '/users/@me/banner',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['users'],
        summary: 'Remove the picture on top of your profile card',
        security,
        response: { 200: selfSchema },
      },
    },
    (request) => users.setBanner(request.auth.userId, null),
  );

  app.patch(
    '/users/@me',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['users'],
        summary: 'Change your profile',
        description:
          'Display name, "about me", status line, accent colour and how you want to be seen ' +
          '(`invisible` shows you as offline to everyone else). Send only what changes.',
        security,
        body: updateProfileRequestSchema,
        response: { 200: selfSchema },
      },
    },
    (request) => users.updateProfile(request.auth.userId, request.body),
  );

  app.get(
    '/images/:imageId',
    {
      schema: {
        tags: ['users'],
        summary: 'A profile picture or server icon',
        description: 'Public on purpose: the id is random and changes with every upload.',
        params: z.object({ imageId: idSchema }),
      },
    },
    async (request, reply) => {
      const picture = await pictures.read(request.params.imageId);
      if (!picture) throw notFound('image');
      return reply
        .header('content-type', picture.contentType)
        .header('cache-control', 'public, max-age=31536000, immutable')
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .send(picture.data);
    },
  );
};
