import {
  hasPermission,
  Permissions,
  type InternalVoicePeer,
  type VoiceTokenResponse,
} from '@frequencia/shared';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../../config';
import { schema, type Database } from '../../db/client';
import { forbidden, notFound } from '../../errors';
import type { GatewayBus } from '../../gateway/bus';
import { buildIceServers } from '../../lib/ice';
import type { Redis } from '../../redis';
import { channelPermissionsOf, loadGuildSnapshot } from '../guilds/snapshot';
import type { MediaLink, VoiceStateEvent } from './media-link';
import { toVoiceState, type VoiceEntry, type VoiceStateStore } from './voice-state';
import { signVoiceToken } from './voice-token';

const { channels } = schema;

const grantKey = (channelId: string, userId: string) => `voice:grant:${channelId}:${userId}`;
const eventKey = (eventId: string) => `voice:event:${eventId}`;
const GRANT_TTL_SECONDS = 24 * 60 * 60;
const EVENT_DEDUPE_SECONDS = 60;

interface Grant {
  speak: boolean;
  stream: boolean;
}

export interface VoiceAccessDeps {
  db: Database;
  redis: Redis;
  bus: GatewayBus;
  voiceStates: VoiceStateStore;
  config: Config;
  log: FastifyBaseLogger;
}

/**
 * Everything about who may be in a voice channel: issuing the tokens that let browsers into
 * the media service, mirroring what the media service reports, and throwing people out when
 * they lose access.
 */
export class VoiceAccess {
  private media: MediaLink | null = null;
  /** channel id -> guild id; channels never move between guilds. */
  private readonly guildOfChannel = new Map<string, string | null>();

  constructor(private readonly deps: VoiceAccessDeps) {}

  attach(media: MediaLink): void {
    this.media = media;
  }

  /** Issues the short-lived token the media service asks for, if the user may connect. */
  async issueToken(userId: string, channelId: string): Promise<VoiceTokenResponse> {
    const guildId = await this.guildOf(channelId);
    const snapshot = guildId ? await loadGuildSnapshot(this.deps.db, guildId) : null;
    const channel = snapshot?.channels.get(channelId);
    const member = snapshot?.members.get(userId);
    const permissions = snapshot ? channelPermissionsOf(snapshot, userId, channelId) : 0n;
    if (!snapshot || !channel || !member || !hasPermission(permissions, Permissions.ViewChannel)) {
      throw notFound('channel');
    }
    if (channel.type !== 'voice') throw notFound('voice channel');
    if (!hasPermission(permissions, Permissions.Connect)) {
      throw forbidden('you cannot connect to this channel');
    }

    const grant: Grant = {
      speak: hasPermission(permissions, Permissions.Speak) && !member.serverMuted,
      stream: hasPermission(permissions, Permissions.Stream),
    };
    await this.deps.redis.set(
      grantKey(channelId, userId),
      JSON.stringify(grant),
      'EX',
      GRANT_TTL_SECONDS,
    );
    const token = await signVoiceToken(
      { sub: userId, name: member.nickname ?? member.displayName, room: channelId, ...grant },
      {
        secret: this.deps.config.MEDIA_SHARED_SECRET,
        ttlSeconds: this.deps.config.VOICE_TOKEN_TTL_SECONDS,
      },
    );
    return { token, iceServers: buildIceServers(this.deps.config, userId) };
  }

  /**
   * Re-checks everyone in the guild's voice channels after a permission change. People who
   * lost access are removed; people whose speak/stream rights changed are made to rejoin so
   * a new token carries the new rights.
   */
  async enforce(guildId: string): Promise<void> {
    const snapshot = await loadGuildSnapshot(this.deps.db, guildId);
    if (!snapshot) return;
    const voiceChannels = [...snapshot.channels.values()].filter((c) => c.type === 'voice');
    const entries = await this.deps.voiceStates.listChannels(voiceChannels.map((c) => c.id));

    await Promise.all(
      entries.map(async (entry) => {
        const permissions = channelPermissionsOf(snapshot, entry.userId, entry.channelId);
        if (!hasPermission(permissions, Permissions.ViewChannel | Permissions.Connect)) {
          await this.disconnect(entry.userId, entry.channelId, 'kicked');
          return;
        }
        const raw = await this.deps.redis.get(grantKey(entry.channelId, entry.userId));
        const grant = raw ? (JSON.parse(raw) as Grant) : null;
        const speak =
          hasPermission(permissions, Permissions.Speak) &&
          !snapshot.members.get(entry.userId)?.serverMuted;
        if (
          grant &&
          (grant.speak !== speak || grant.stream !== hasPermission(permissions, Permissions.Stream))
        ) {
          await this.disconnect(entry.userId, entry.channelId, 'permissions');
        }
      }),
    );
  }

  /** Takes a user out of whatever voice channel of the guild they are in. They may rejoin. */
  async kick(guildId: string, userId: string): Promise<boolean> {
    const snapshot = await loadGuildSnapshot(this.deps.db, guildId);
    if (!snapshot) return false;
    const voiceChannels = [...snapshot.channels.values()].filter((c) => c.type === 'voice');
    const entries = await this.deps.voiceStates.listChannels(voiceChannels.map((c) => c.id));
    const mine = entries.filter((entry) => entry.userId === userId);
    await Promise.all(mine.map((entry) => this.disconnect(userId, entry.channelId, 'kicked')));
    return mine.length > 0;
  }

  /** The channel is gone: close its room and forget who was in it. */
  async closeChannel(channelId: string): Promise<void> {
    this.guildOfChannel.delete(channelId);
    await this.deps.voiceStates.clearChannel(channelId);
    await this.media?.request('closeRoom', { roomId: channelId }).catch((error: unknown) => {
      this.deps.log.warn({ err: error, channelId }, 'could not close voice room');
    });
  }

  // --- mirror of the media service ----------------------------------------------------------

  /** Applies one membership change reported by the media service. */
  async applyVoiceState(event: VoiceStateEvent): Promise<void> {
    // Every API instance receives the event; only the first one to claim it processes it.
    const claimed = await this.deps.redis.set(
      eventKey(event.eventId),
      '1',
      'EX',
      EVENT_DEDUPE_SECONDS,
      'NX',
    );
    if (!claimed) return;

    const guildId = await this.guildOf(event.roomId);
    if (!guildId) return; // Lab rooms and deleted channels are not mirrored.

    if (event.state === null) {
      await this.deps.voiceStates.markLeft(event.peerId);
      const removed = await this.deps.voiceStates.remove(event.roomId, event.userId, event.peerId);
      if (removed) await this.publishLeft(removed);
      return;
    }
    const entry: VoiceEntry = {
      guildId,
      channelId: event.roomId,
      userId: event.userId,
      peerId: event.peerId,
      ...event.state,
    };
    await this.deps.voiceStates.set(entry);
    await this.publish(entry);
  }

  /** Rebuilds the mirror from a snapshot, after the link to the media service (re)opens. */
  async resync(snapshot: () => Promise<InternalVoicePeer[]>): Promise<void> {
    const since = await this.deps.voiceStates.clock();
    await this.reconcile(await snapshot(), since);
  }

  /**
   * Reconciles the mirror with a full snapshot. Events keep being applied while the snapshot
   * travels (by this instance or another one), so anything written after `since`, the clock
   * value read before the snapshot was requested, is newer than the snapshot and wins.
   */
  async reconcile(peers: InternalVoicePeer[], since: number): Promise<void> {
    const actual = new Map(peers.map((peer) => [`${peer.roomId}:${peer.userId}`, peer]));
    for (const stale of await this.deps.voiceStates.listAll()) {
      if (actual.get(`${stale.channelId}:${stale.userId}`)?.peerId === stale.peerId) continue;
      if (stale.version > since) continue;
      if (await this.deps.voiceStates.remove(stale.channelId, stale.userId, stale.peerId)) {
        await this.publishLeft(stale);
      }
    }
    for (const peer of peers) {
      const guildId = await this.guildOf(peer.roomId);
      if (!guildId) continue;
      const current = await this.deps.voiceStates.get(peer.roomId, peer.userId);
      if (current && current.version > since) continue;
      if (await this.deps.voiceStates.hasLeft(peer.peerId)) continue;
      const entry: VoiceEntry = {
        guildId,
        channelId: peer.roomId,
        userId: peer.userId,
        peerId: peer.peerId,
        ...peer.state,
      };
      await this.deps.voiceStates.set(entry);
      await this.publish(entry);
    }
  }

  private publish(entry: VoiceEntry): Promise<void> {
    return this.deps.bus.event(
      entry.guildId,
      'VOICE_STATE_UPDATE',
      toVoiceState(entry),
      entry.channelId,
    );
  }

  private publishLeft(entry: VoiceEntry): Promise<void> {
    return this.deps.bus.event(
      entry.guildId,
      'VOICE_STATE_UPDATE',
      { ...toVoiceState(entry), channelId: null, streaming: false },
      entry.channelId,
    );
  }

  private async disconnect(
    userId: string,
    channelId: string,
    reason: 'kicked' | 'permissions',
  ): Promise<void> {
    await this.media
      ?.request('disconnectUser', { userId, roomId: channelId, reason })
      .catch((error: unknown) => {
        this.deps.log.warn({ err: error, userId, channelId }, 'could not disconnect from voice');
      });
  }

  private async guildOf(channelId: string): Promise<string | null> {
    const cached = this.guildOfChannel.get(channelId);
    if (cached) return cached;
    if (!/^[0-9a-f-]{36}$/i.test(channelId)) return null;
    const [row] = await this.deps.db
      .select({ guildId: channels.guildId })
      .from(channels)
      .where(eq(channels.id, channelId));
    if (row) this.guildOfChannel.set(channelId, row.guildId);
    return row?.guildId ?? null;
  }
}
