import type { InternalVoiceState, VoiceState } from '@frequencia/shared';
import type { Redis } from '../../redis';

const ROOMS = 'voice:rooms';
const room = (channelId: string) => `voice:room:${channelId}`;

interface StoredVoiceState extends InternalVoiceState {
  guildId: string;
  /** Media session id, to tell a reconnect apart from the session it replaced. */
  peerId: string;
}

export interface VoiceEntry extends VoiceState {
  peerId: string;
}

/**
 * Who is in which voice channel, kept in Redis so any API instance can answer. The media
 * service is the source of truth; this is its mirror (see `MediaLink`).
 */
export class VoiceStateStore {
  constructor(private readonly redis: Redis) {}

  async set(entry: VoiceEntry): Promise<void> {
    const { channelId, userId, ...rest } = entry;
    const stored: StoredVoiceState = {
      guildId: rest.guildId,
      peerId: rest.peerId,
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
  async remove(channelId: string, userId: string, peerId?: string): Promise<VoiceEntry | null> {
    const current = await this.get(channelId, userId);
    if (!current || (peerId && current.peerId !== peerId)) return null;
    await this.redis.hdel(room(channelId), userId);
    if ((await this.redis.hlen(room(channelId))) === 0) await this.redis.srem(ROOMS, channelId);
    return current;
  }

  async get(channelId: string, userId: string): Promise<VoiceEntry | null> {
    const raw = await this.redis.hget(room(channelId), userId);
    return raw ? toEntry(channelId, userId, raw) : null;
  }

  async listChannel(channelId: string): Promise<VoiceEntry[]> {
    const entries = await this.redis.hgetall(room(channelId));
    return Object.entries(entries).map(([userId, raw]) => toEntry(channelId, userId, raw));
  }

  async listChannels(channelIds: readonly string[]): Promise<VoiceEntry[]> {
    if (channelIds.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const channelId of channelIds) pipeline.hgetall(room(channelId));
    const results = (await pipeline.exec()) ?? [];
    return channelIds.flatMap((channelId, index) => {
      const entries = (results[index]?.[1] as Record<string, string> | null) ?? {};
      return Object.entries(entries).map(([userId, raw]) => toEntry(channelId, userId, raw));
    });
  }

  async listAll(): Promise<VoiceEntry[]> {
    return this.listChannels(await this.redis.smembers(ROOMS));
  }

  async clearChannel(channelId: string): Promise<VoiceEntry[]> {
    const entries = await this.listChannel(channelId);
    await this.redis.multi().del(room(channelId)).srem(ROOMS, channelId).exec();
    return entries;
  }
}

function toEntry(channelId: string, userId: string, raw: string): VoiceEntry {
  const stored = JSON.parse(raw) as StoredVoiceState;
  return { channelId, userId, ...stored };
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
