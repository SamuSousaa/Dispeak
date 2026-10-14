import {
  apiErrorSchema,
  idSchema,
  streamReportListSchema,
  streamReportSchema,
} from '@frequencia/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

/** Telemetry of past screen shares, for the streamer and the owner of the server. */
export const streamReportRoutes: FastifyPluginAsyncZod = async (app) => {
  const { streamReports } = app.ctx;
  const security = [{ bearerAuth: [] }];

  app.addHook('onRequest', app.authenticate);

  app.get(
    '/stream-reports',
    {
      schema: {
        tags: ['streams'],
        summary: 'Recent screen shares you sent, or that happened in a server you own',
        security,
        response: { 200: streamReportListSchema },
      },
    },
    async (request) => ({ reports: await streamReports.list(request.auth.userId) }),
  );

  app.get(
    '/stream-reports/:reportId',
    {
      schema: {
        tags: ['streams'],
        summary: 'One screen share, measured at the streamer, the server and each viewer',
        security,
        params: z.object({ reportId: idSchema }),
        response: { 200: streamReportSchema, 404: apiErrorSchema },
      },
    },
    (request) => streamReports.get(request.auth.userId, request.params.reportId),
  );
};
