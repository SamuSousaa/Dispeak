import {
  ApiErrorCode,
  featuresSchema,
  gifPageSchema,
  gifSearchQuerySchema,
  linkPreviewSchema,
  unfurlQuerySchema,
} from '@frequencia/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { AppError, notFound } from '../../errors';
import { perUser } from '../../lib/per-user-limit';

/** What the chat shows around messages: link previews and the GIF picker. */
export const embedRoutes: FastifyPluginAsyncZod = async (app) => {
  const { linkPreviews, gifs, config } = app.ctx;
  const security = [{ bearerAuth: [] }];
  app.addHook('onRequest', app.authenticate);

  app.get(
    '/features',
    {
      schema: {
        tags: ['embeds'],
        summary: 'Optional features enabled on this installation',
        security,
        response: { 200: featuresSchema },
      },
    },
    () => ({ gifs: gifs.enabled, linkPreviews: config.LINK_PREVIEWS }),
  );

  app.get(
    '/unfurl',
    {
      // Each call may make the server fetch a page: keep it well below the general limit.
      config: perUser(config.RATE_LIMIT_UNFURL_MAX),
      schema: {
        tags: ['embeds'],
        summary: 'Preview of a link: title, description and picture',
        description:
          'Answers `null` when the link has nothing to show or cannot be reached. Only public ' +
          'http(s) addresses are fetched.',
        security,
        querystring: unfurlQuerySchema,
        response: { 200: linkPreviewSchema.nullable() },
      },
    },
    async (request, reply) => {
      if (!config.LINK_PREVIEWS) throw notFound('link previews');
      const preview = await linkPreviews.get(request.query.url);
      // The same link gives the same preview to everyone, for a while.
      return reply.header('cache-control', 'private, max-age=600').send(preview);
    },
  );

  app.get(
    '/gifs',
    {
      config: perUser(config.RATE_LIMIT_UNFURL_MAX),
      schema: {
        tags: ['embeds'],
        summary: 'Search GIFs (trending ones for an empty query)',
        security,
        querystring: gifSearchQuerySchema,
        response: { 200: gifPageSchema },
      },
    },
    async (request) => {
      if (!gifs.enabled) throw notFound('gif search');
      try {
        return { gifs: await gifs.search(request.query.q) };
      } catch (error) {
        request.log.warn({ err: error }, 'gif search failed');
        throw new AppError(502, ApiErrorCode.Internal, 'gif search is unavailable');
      }
    },
  );
};
