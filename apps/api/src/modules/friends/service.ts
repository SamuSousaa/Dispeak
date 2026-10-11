import {
  DM_PERMISSIONS,
  type FriendRequest,
  type Guild,
  type SendFriendRequestResponse,
} from '@frequencia/shared';
import { and, eq, or } from 'drizzle-orm';
import { schema, type Database } from '../../db/client';
import { badRequest, conflict, notFound } from '../../errors';
import type { GatewayBus } from '../../gateway/bus';
import { uuidv7 } from '../../lib/ids';
import { publicUserColumns, toPublicUser, type PublicUserRow } from '../../lib/user';
import { buildGuildPayload, type LiveState } from '../guilds/live';
import { loadGuildSnapshot } from '../guilds/snapshot';
import type { VoiceAccess } from '../voice/voice-access';

const { users, guilds, guildMembers, roles, channels, friendRequests } = schema;

type RequestRow = typeof friendRequests.$inferSelect;

/** The same key whoever asks: the two ids in order. */
const dmKeyOf = (a: string, b: string) => [a, b].sort().join(':');

function toRequest(row: RequestRow, readerId: string, other: PublicUserRow): FriendRequest {
  return {
    id: row.id,
    user: toPublicUser(other),
    direction: row.toId === readerId ? 'incoming' : 'outgoing',
    createdAt: row.createdAt.toISOString(),
  };
}

export interface FriendServiceDeps {
  db: Database;
  bus: GatewayBus;
  live: LiveState;
  voice: VoiceAccess;
}

/**
 * Friendships. One is asked for by username and, once accepted, becomes the private
 * conversation of the pair: a guild of kind `dm` with a text and a voice channel, which reuses
 * everything a server has (messages, calls, screen shares, presence). Being friends *is* having
 * that guild, so there is nothing else to keep in step with it.
 */
export class FriendService {
  constructor(private readonly deps: FriendServiceDeps) {}

  private get db() {
    return this.deps.db;
  }

  /** Requests waiting for an answer, made to the user or by them. */
  async listRequests(userId: string): Promise<FriendRequest[]> {
    const rows = await this.db
      .select({ request: friendRequests, user: publicUserColumns })
      .from(friendRequests)
      .innerJoin(
        users,
        or(
          and(eq(friendRequests.toId, userId), eq(users.id, friendRequests.fromId)),
          and(eq(friendRequests.fromId, userId), eq(users.id, friendRequests.toId)),
        ),
      )
      .where(or(eq(friendRequests.toId, userId), eq(friendRequests.fromId, userId)))
      .orderBy(friendRequests.createdAt);
    return rows.map(({ request, user }) => toRequest(request, userId, user));
  }

  /**
   * Asks someone, by username, to be a friend. When that person had already asked, the two
   * requests meet and the conversation opens right away.
   */
  async request(userId: string, username: string): Promise<SendFriendRequestResponse> {
    const [self] = await this.db.select(publicUserColumns).from(users).where(eq(users.id, userId));
    const [target] = await this.db
      .select(publicUserColumns)
      .from(users)
      .where(eq(users.username, username));
    if (!self || !target) throw notFound('user');
    if (target.id === userId) throw badRequest('you cannot add yourself');
    if (await this.conversationOf(userId, target.id)) throw conflict('you are already friends');

    const [theirs] = await this.db
      .select()
      .from(friendRequests)
      .where(and(eq(friendRequests.fromId, target.id), eq(friendRequests.toId, userId)));
    if (theirs) return { request: null, guild: await this.accept(userId, theirs.id) };

    const [row] = await this.db
      .insert(friendRequests)
      .values({ id: uuidv7(), fromId: userId, toId: target.id })
      .onConflictDoNothing()
      .returning();
    if (!row) throw conflict('you have already asked');

    await this.deps.bus.userEvent(
      target.id,
      'FRIEND_REQUEST_CREATE',
      toRequest(row, target.id, self),
    );
    const request = toRequest(row, userId, target);
    await this.deps.bus.userEvent(userId, 'FRIEND_REQUEST_CREATE', request);
    return { request, guild: null };
  }

  /** Accepts a request made to the user and opens the conversation of the two. */
  async accept(userId: string, requestId: string): Promise<Guild> {
    const [row] = await this.db
      .select()
      .from(friendRequests)
      .where(and(eq(friendRequests.id, requestId), eq(friendRequests.toId, userId)));
    if (!row) throw notFound('friend request');

    const guildId = uuidv7();
    const created = await this.db.transaction(async (tx) => {
      await tx
        .delete(friendRequests)
        .where(
          or(
            and(eq(friendRequests.fromId, row.fromId), eq(friendRequests.toId, row.toId)),
            and(eq(friendRequests.fromId, row.toId), eq(friendRequests.toId, row.fromId)),
          ),
        );
      // Two acceptances racing each other end in one conversation.
      const [guild] = await tx
        .insert(guilds)
        .values({
          id: guildId,
          kind: 'dm',
          dmKey: dmKeyOf(row.fromId, row.toId),
          name: 'dm',
          ownerId: row.fromId,
        })
        .onConflictDoNothing()
        .returning({ id: guilds.id });
      if (!guild) return false;
      await tx.insert(guildMembers).values([
        { guildId, userId: row.fromId },
        { guildId, userId: row.toId },
      ]);
      // @everyone shares its id with the guild.
      await tx.insert(roles).values({
        id: guildId,
        guildId,
        name: '@everyone',
        permissions: DM_PERMISSIONS,
        position: 0,
      });
      await tx.insert(channels).values([
        { id: uuidv7(), guildId, type: 'text', name: 'conversa', position: 0 },
        { id: uuidv7(), guildId, type: 'voice', name: 'chamada', position: 1 },
      ]);
      return true;
    });

    for (const id of [row.fromId, row.toId]) {
      await this.deps.bus.userEvent(id, 'FRIEND_REQUEST_DELETE', { id: row.id });
      if (created) await this.deps.bus.publish({ kind: 'guild-join', guildId, userId: id });
    }
    const existing = created ? guildId : await this.conversationOf(row.fromId, row.toId);
    const snapshot = existing ? await loadGuildSnapshot(this.db, existing) : null;
    if (!snapshot) throw notFound('conversation');
    return buildGuildPayload(this.deps.live, snapshot, userId);
  }

  /** Declines a request made to the user, or withdraws one they made. */
  async removeRequest(userId: string, requestId: string): Promise<void> {
    const [row] = await this.db
      .delete(friendRequests)
      .where(
        and(
          eq(friendRequests.id, requestId),
          or(eq(friendRequests.toId, userId), eq(friendRequests.fromId, userId)),
        ),
      )
      .returning();
    if (!row) throw notFound('friend request');
    for (const id of [row.fromId, row.toId]) {
      await this.deps.bus.userEvent(id, 'FRIEND_REQUEST_DELETE', { id: row.id });
    }
  }

  /** Ends a friendship: the conversation and everything said in it are gone for both. */
  async remove(userId: string, friendId: string): Promise<void> {
    const guildId = await this.conversationOf(userId, friendId);
    if (!guildId) throw notFound('friend');
    const voiceChannels = await this.db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.guildId, guildId), eq(channels.type, 'voice')));
    await this.db.delete(guilds).where(eq(guilds.id, guildId));
    await this.deps.bus.publish({ kind: 'guild-delete', guildId });
    await Promise.all(voiceChannels.map((channel) => this.deps.voice.closeChannel(channel.id)));
  }

  private async conversationOf(a: string, b: string): Promise<string | null> {
    const [guild] = await this.db
      .select({ id: guilds.id })
      .from(guilds)
      .where(eq(guilds.dmKey, dmKeyOf(a, b)));
    return guild?.id ?? null;
  }
}
