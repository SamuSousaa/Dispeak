import { streamReportListSchema, streamReportSchema } from '@frequencia/shared';
import { api } from '../../lib/http';

/** Telemetry of past screen shares: the streamer's own, and those in servers the user owns. */
export const streamApi = {
  list: async () =>
    (await api('GET', '/stream-reports', { schema: streamReportListSchema })).reports,
  get: (reportId: string) =>
    api('GET', `/stream-reports/${reportId}`, { schema: streamReportSchema }),
};
