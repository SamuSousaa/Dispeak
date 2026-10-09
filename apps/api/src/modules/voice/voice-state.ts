import type { InternalVoiceState, VoiceState } from '@frequencia/shared';
import type { Redis } from '../../redis';

const ROOMS = 'voice:rooms';
const CLOCK = 'voice:clock';
const room = (channelId: string) => `voice:room:${channelId}`;
const leftKey = (peerId: string) => `voice:left:${peerId}`;
/** Only has to outlive a snapshot round trip. */
const LEFT_TTL_SECONDS = 60;

interface StoredVoiceState extends InternalVoiceState {
  guildId: string;
  /** Media session id, to tell a reconnect apart from the session it replaced. */
  peerId: string;
  /** Value of the shared clock when the entry was written. */
  version?: number;
}

export interface VoiceEntry extends VoiceState {
  peerId: string;
}

export interface StoredVoiceEntry extends VoiceEntry {
  version: number;
}

/**
 * Who is in which voice channel, kept in Redis so any API instance can answer. The media
 * service is the source of truth; this is its mirror (see `MediaLink`).
 */
export class VoiceStateStore {
  constructor(private readonly redis: Redis) {}

  /**
   * Current value of the logical clock every write advances. Read it before asking the media
   * service for a snapshot: entries with a higher version are newer than that snapshot.
   */
  async clock(): Promise<number> {
    return Number((await this.redis.get(CLOCK)) ?? 0);
  }

  async set(entry: VoiceEntry): Promise<void> {
    const { channelId, userId, ...rest } = entry;
    const stored: StoredVoiceState = {
      guildId: rest.guildId,
      peerId: rest.peerId,
      version: await this.redis.incr(CLOCK),
      muted: rest.muted,
      deafened: rest.deafened,
      streaming: rest.streaming,
    };
    await this.redis
      .multi()
      .hset(room(channelId), userId, JSON.stringify(stored))
      .sadd(ROOMS, channelId)
      .exec();
  }

  /**
   * Removes a user from a channel. With `peerId`, only if that is still the stored session,
   * so a late "left" from a replaced session cannot erase its successor.
   */
  async remove(
    channelId: string,
    userId: string,
    peerId?: string,
  ): Promise<StoredVoiceEntry | null> {
    const current = await this.get(channelId, userId);
    if (!current || (peerId && current.peerId !== peerId)) return null;
    await this.redis.hdel(room(channelId), userId);
    if ((await this.redis.hlen(room(channelId))) === 0) await this.redis.srem(ROOMS, channelId);
    return current;
  }

  /** Records that a media session ended, so a snapshot taken before that cannot bring it back. */
  async markLeft(peerId: string): Promise<void> {
    await this.redis.set(leftKey(peerId), '1', 'EX', LEFT_TTL_SECONDS);
  }

  async hasLeft(peerId: string): Promise<boolean> {
    return (await this.redis.exists(leftKey(peerId))) === 1;
  }

  async get(channelId: string, userId: string): Promise<StoredVoiceEntry | null> {
    const raw = await this.redis.hget(room(channelId), userId);
    return raw ? toEntry(channelId, userId, raw) : null;
  }

  async listChannel(channelId: string): Promise<StoredVoiceEntry[]> {
    const entries = await this.redis.hgetall(room(channelId));
    return Object.entries(entries).map(([userId, raw]) => toEntry(channelId, userId, raw));
  }

  async listChannels(channelIds: readonly string[]): Promise<StoredVoiceEntry[]> {
    if (channelIds.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const channelId of channelIds) pipeline.hgetall(room(channelId));
    const results = (await pipeline.exec()) ?? [];
    return channelIds.flatMap((channelId, index) => {
      const entries = (results[index]?.[1] as Record<string, string> | null) ?? {};
      return Object.entries(entries).map(([userId, raw]) => toEntry(channelId, userId, raw));
    });
  }

  async listAll(): Promise<StoredVoiceEntry[]> {
    return this.listChannels(await this.redis.smembers(ROOMS));
  }

  async clearChannel(channelId: string): Promise<StoredVoiceEntry[]> {
    const entries = await this.listChannel(channelId);
    await this.redis.multi().del(room(channelId)).srem(ROOMS, channelId).exec();
    return entries;
  }
}

function toEntry(channelId: string, userId: string, raw: string): StoredVoiceEntry {
  const stored = JSON.parse(raw) as StoredVoiceState;
  return { channelId, userId, ...stored, version: stored.version ?? 0 };
}

export function toVoiceState(entry: VoiceEntry): VoiceState {
  return {
    guildId: entry.guildId,
    channelId: entry.channelId,
    userId: entry.userId,
    muted: entry.muted,
    deafened: entry.deafened,
    streaming: entry.streaming,
  };
}
