import {
  streamSampleSchema,
  type apiInternalSide,
  type EventData,
  type StreamReport,
  type StreamReportSummary,
} from '@frequencia/shared';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { schema, type Database } from '../../db/client';
import { notFound } from '../../errors';
import type { Redis } from '../../redis';

const { streamReports, channels, guilds, users } = schema;

export type StreamReportEvent = EventData<typeof apiInternalSide, 'stream-report'>;

const eventKey = (eventId: string) => `stream:event:${eventId}`;
const EVENT_DEDUPE_SECONDS = 600;
/** Reports older than this are deleted. */
export const STREAM_REPORT_RETENTION_DAYS = 30;
const LIST_LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const summaryColumns = {
  id: streamReports.id,
  channelId: streamReports.channelId,
  channelName: channels.name,
  guildName: guilds.name,
  userId: streamReports.userId,
  userName: users.displayName,
  path: streamReports.path,
  codec: streamReports.codec,
  startedAt: streamReports.startedAt,
  endedAt: streamReports.endedAt,
  sampleCount: sql<number>`jsonb_array_length(${streamReports.samples})`.mapWith(Number),
};

interface SummaryRow extends Omit<StreamReportSummary, 'path' | 'startedAt' | 'endedAt'> {
  path: string;
  startedAt: Date;
  endedAt: Date | null;
}

function toSummary(row: SummaryRow): StreamReportSummary {
  return {
    ...row,
    path: row.path === 'native' ? 'native' : 'browser',
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}

export interface StreamReportServiceDeps {
  db: Database;
  redis: Redis;
  log: FastifyBaseLogger;
}

/**
 * Keeps the telemetry the media service sends about screen shares, and shows it to the people
 * it concerns: the streamer, and the owner of the server the stream happened in.
 */
export class StreamReportService {
  constructor(private readonly deps: StreamReportServiceDeps) {}

  /** Stores one chunk of a stream: creates its report, or adds to it. */
  async record(event: StreamReportEvent): Promise<void> {
    // Lab rooms are not channels, and their people are not users.
    if (!UUID.test(event.roomId) || !UUID.test(event.userId) || !UUID.test(event.producerId)) {
      return;
    }
    // Every API instance receives the event; only the first one to claim it stores it.
    const claimed = await this.deps.redis.set(
      eventKey(event.eventId),
      '1',
      'EX',
      EVENT_DEDUPE_SECONDS,
      'NX',
    );
    if (!claimed) return;

    const samples = JSON.stringify(event.samples);
    const endedAt = event.endedAt ? new Date(event.endedAt) : null;
    try {
      await this.deps.db
        .insert(streamReports)
        .values({
          id: event.producerId,
          channelId: event.roomId,
          userId: event.userId,
          path: event.path,
          codec: event.codec,
          startedAt: new Date(event.startedAt),
          endedAt,
          samples: sql`${samples}::jsonb`,
        })
        .onConflictDoUpdate({
          target: streamReports.id,
          set: {
            samples: sql`${streamReports.samples} || ${samples}::jsonb`,
            endedAt: sql`coalesce(excluded.ended_at, ${streamReports.endedAt})`,
          },
        });
    } catch (error) {
      // The channel or the user may be gone already: nothing to keep.
      this.deps.log.debug({ err: error, producerId: event.producerId }, 'stream report dropped');
    }
  }

  /** Recent streams the user sent, or that happened in a server the user owns. */
  async list(userId: string): Promise<StreamReportSummary[]> {
    const rows = await this.deps.db
      .select(summaryColumns)
      .from(streamReports)
      .innerJoin(channels, eq(channels.id, streamReports.channelId))
      .innerJoin(guilds, eq(guilds.id, channels.guildId))
      .innerJoin(users, eq(users.id, streamReports.userId))
      .where(this.visibleTo(userId))
      .orderBy(desc(streamReports.startedAt))
      .limit(LIST_LIMIT);
    return rows.map(toSummary);
  }

  async get(userId: string, reportId: string): Promise<StreamReport> {
    const [row] = await this.deps.db
      .select({ ...summaryColumns, samples: streamReports.samples })
      .from(streamReports)
      .innerJoin(channels, eq(channels.id, streamReports.channelId))
      .innerJoin(guilds, eq(guilds.id, channels.guildId))
      .innerJoin(users, eq(users.id, streamReports.userId))
      .where(and(eq(streamReports.id, reportId), this.visibleTo(userId)));
    if (!row) throw notFound('stream report');
    const { samples, ...summary } = row;
    // Stored as the media service sent them, anything unreadable left out. Chunks sent close
    // together (the last one right after a regular one) may have been stored out of order.
    const parsed = z.array(z.unknown()).safeParse(samples);
    const readable = (parsed.success ? parsed.data : [])
      .flatMap((sample) => {
        const result = streamSampleSchema.safeParse(sample);
        return result.success ? [result.data] : [];
      })
      .sort((a, b) => a.t - b.t);
    const viewerIds = [
      ...new Set(readable.flatMap((sample) => sample.viewers.map((viewer) => viewer.userId))),
    ];
    const viewers =
      viewerIds.length > 0
        ? await this.deps.db
            .select({ id: users.id, name: users.displayName })
            .from(users)
            .where(inArray(users.id, viewerIds))
        : [];
    return {
      ...toSummary(summary),
      samples: readable,
      viewerNames: Object.fromEntries(viewers.map((viewer) => [viewer.id, viewer.name])),
    };
  }

  /** Deletes reports past the retention period. */
  async sweep(): Promise<number> {
    const cutoff = new Date(Date.now() - STREAM_REPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const deleted = await this.deps.db
      .delete(streamReports)
      .where(lt(streamReports.startedAt, cutoff))
      .returning({ id: streamReports.id });
    return deleted.length;
  }

  private visibleTo(userId: string) {
    return or(
      eq(streamReports.userId, userId),
      and(eq(guilds.ownerId, userId), eq(guilds.kind, 'server')),
    );
  }
}
