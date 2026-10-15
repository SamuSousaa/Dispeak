import { ApiErrorCode, DM_PERMISSIONS, type Guild, type User } from '@frequencia/shared';
import { and, eq, inArray, or } from 'drizzle-orm';
import { schema, type Database, type Queryable } from '../../db/client';
import { AppError, badRequest, notFound } from '../../errors';
import type { GatewayBus } from '../../gateway/bus';
import { uuidv7 } from '../../lib/ids';
import { publicUserColumns, toPublicUser } from '../../lib/user';
import { buildGuildPayload, type LiveState } from '../guilds/live';
import { loadGuildSnapshot, type GuildSnapshot } from '../guilds/snapshot';
import type { UserSettingsService } from '../users/settings';
import type { VoiceAccess } from '../voice/voice-access';

const {
  users,
  guilds,
  guildMembers,
  roles,
  channels,
  friendships,
  friendRequests,
  dmRequests,
  userBlocks,
} = schema;

/** The two ids of a pair, smaller first: how friendships are stored. */
export const pairOf = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

/** The same key whoever asks: the two ids in order. */
export const dmKeyOf = (a: string, b: string) => pairOf(a, b).join(':');

const blocked = () => new AppError(403, ApiErrorCode.Blocked, 'one of you blocks the other');

export interface ConversationServiceDeps {
  db: Database;
  bus: GatewayBus;
  live: LiveState;
  voice: VoiceAccess;
  settings: UserSettingsService;
}

/**
 * Private conversations, apart from friendships (ADR 0015). Friends always have one; people
 * who share a server can start one, unless the other keeps a private profile, and the first one
 * from someone who is not a friend waits as a request. Blocking closes a conversation both
 * ways. The rules themselves live in the guild snapshot, as permissions, so messages and calls
 * need no check of their own.
 */
export class ConversationService {
  constructor(private readonly deps: ConversationServiceDeps) {}

  private get db() {
    return this.deps.db;
  }

  async areFriends(a: string, b: string, db: Queryable = this.db): Promise<boolean> {
    const [low, high] = pairOf(a, b);
    const [row] = await db
      .select({ userLow: friendships.userLow })
      .from(friendships)
      .where(and(eq(friendships.userLow, low), eq(friendships.userHigh, high)));
    return Boolean(row);
  }

  async isBlockedBetween(a: string, b: string): Promise<boolean> {
    const [row] = await this.db
      .select({ blockerId: userBlocks.blockerId })
      .from(userBlocks)
      .where(
        or(
          and(eq(userBlocks.blockerId, a), eq(userBlocks.blockedId, b)),
          and(eq(userBlocks.blockerId, b), eq(userBlocks.blockedId, a)),
        ),
      );
    return Boolean(row);
  }

  async conversationOf(a: string, b: string, db: Queryable = this.db): Promise<string | null> {
    const [guild] = await db
      .select({ id: guilds.id })
      .from(guilds)
      .where(eq(guilds.dmKey, dmKeyOf(a, b)));
    return guild?.id ?? null;
  }

  /**
   * The conversation of two people, created when there is none: a guild of kind `dm` with a
   * text and a voice channel. `requestTo` makes a new one a request to that person. Two
   * creations racing each other end in one conversation.
   */
  async ensure(
    tx: Queryable,
    a: string,
    b: string,
    requestTo: string | null = null,
  ): Promise<{ guildId: string; created: boolean }> {
    const existing = await this.conversationOf(a, b, tx);
    if (existing) return { guildId: existing, created: false };
    const guildId = uuidv7();
    const [guild] = await tx
      .insert(guilds)
      .values({ id: guildId, kind: 'dm', dmKey: dmKeyOf(a, b), name: 'dm', ownerId: a })
      .onConflictDoNothing()
      .returning({ id: guilds.id });
    if (!guild) {
      const raced = await this.conversationOf(a, b, tx);
      if (!raced) throw new Error('conversation vanished while being created');
      return { guildId: raced, created: false };
    }
    await tx.insert(guildMembers).values([
      { guildId, userId: a },
      { guildId, userId: b },
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
    if (requestTo) await tx.insert(dmRequests).values({ guildId, recipientId: requestTo });
    return { guildId, created: true };
  }

  /** Tells both people a conversation now exists. */
  async announce(guildId: string, userIds: string[]): Promise<void> {
    for (const userId of userIds) {
      await this.deps.bus.publish({ kind: 'guild-join', guildId, userId });
    }
  }

  async payload(guildId: string, userId: string): Promise<Guild> {
    const snapshot = await loadGuildSnapshot(this.db, guildId);
    if (!snapshot) throw notFound('conversation');
    return buildGuildPayload(this.deps.live, snapshot, userId);
  }

  /**
   * The conversation with someone, opened from their profile or their name: the existing one,
   * or a new one when the two are friends or share a server and the other takes messages from
   * people who are not friends.
   */
  async open(userId: string, targetId: string): Promise<Guild> {
    if (targetId === userId) throw badRequest('you cannot talk to yourself');
    const [target] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, targetId));
    if (!target) throw notFound('user');

    const existing = await this.conversationOf(userId, targetId);
    if (existing) {
      // Opening one that waited (or was declined) is answering it.
      const [accepted] = await this.db
        .delete(dmRequests)
        .where(and(eq(dmRequests.guildId, existing), eq(dmRequests.recipientId, userId)))
        .returning();
      if (accepted) await this.deps.bus.sync(existing);
      return this.payload(existing, userId);
    }

    if (await this.isBlockedBetween(userId, targetId)) throw blocked();
    const friends = await this.areFriends(userId, targetId);
    if (!friends) {
      const settings = await this.deps.settings.get(targetId);
      if (settings.privateProfile) {
        throw new AppError(403, ApiErrorCode.DmClosed, 'this person only talks to friends');
      }
      if (!(await this.shareServer(userId, targetId))) {
        throw new AppError(403, ApiErrorCode.DmClosed, 'you share no server with this person');
      }
    }
    const { guildId, created } = await this.db.transaction((tx) =>
      this.ensure(tx, userId, targetId, friends ? null : targetId),
    );
    if (created) await this.announce(guildId, [userId, targetId]);
    return this.payload(guildId, userId);
  }

  /** The recipient takes a request: the conversation becomes like any other. */
  async accept(userId: string, guildId: string): Promise<void> {
    const [row] = await this.db
      .delete(dmRequests)
      .where(and(eq(dmRequests.guildId, guildId), eq(dmRequests.recipientId, userId)))
      .returning();
    if (!row) throw notFound('message request');
    await this.deps.bus.sync(guildId);
  }

  /** The recipient turns a request down: it disappears for them; the sender is not told. */
  async decline(userId: string, guildId: string): Promise<void> {
    const [row] = await this.db
      .update(dmRequests)
      .set({ declined: true })
      .where(and(eq(dmRequests.guildId, guildId), eq(dmRequests.recipientId, userId)))
      .returning();
    if (!row) throw notFound('message request');
    await this.deps.bus.sync(guildId);
  }

  /**
   * After a message in a private conversation: the recipient of a request answering accepts
   * it, and the first message of its sender shows it to the recipient.
   */
  async afterMessage(snapshot: GuildSnapshot, authorId: string): Promise<void> {
    const request = snapshot.dm?.request;
    if (!request) return;
    const guildId = snapshot.guild.id;
    if (request.recipientId === authorId) {
      await this.db.delete(dmRequests).where(eq(dmRequests.guildId, guildId));
    } else if (!request.sent) {
      await this.db.update(dmRequests).set({ sent: true }).where(eq(dmRequests.guildId, guildId));
    } else {
      return;
    }
    await this.deps.bus.sync(guildId);
  }

  async blockedIds(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ blockedId: userBlocks.blockedId })
      .from(userBlocks)
      .where(eq(userBlocks.blockerId, userId))
      .orderBy(userBlocks.createdAt);
    return rows.map((row) => row.blockedId);
  }

  async listBlocks(userId: string): Promise<User[]> {
    const rows = await this.db
      .select(publicUserColumns)
      .from(userBlocks)
      .innerJoin(users, eq(users.id, userBlocks.blockedId))
      .where(eq(userBlocks.blockerId, userId))
      .orderBy(userBlocks.createdAt);
    return rows.map(toPublicUser);
  }

  /**
   * Blocks someone: the friendship and any friend request between the two end, their
   * conversation (kept) closes both ways, and a call in it ends.
   */
  async block(userId: string, targetId: string): Promise<void> {
    if (targetId === userId) throw badRequest('you cannot block yourself');
    const [target] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, targetId));
    if (!target) throw notFound('user');
    const [low, high] = pairOf(userId, targetId);
    const requests = await this.db.transaction(async (tx) => {
      await tx
        .insert(userBlocks)
        .values({ blockerId: userId, blockedId: targetId })
        .onConflictDoNothing();
      await tx
        .delete(friendships)
        .where(and(eq(friendships.userLow, low), eq(friendships.userHigh, high)));
      return tx
        .delete(friendRequests)
        .where(
          or(
            and(eq(friendRequests.fromId, userId), eq(friendRequests.toId, targetId)),
            and(eq(friendRequests.fromId, targetId), eq(friendRequests.toId, userId)),
          ),
        )
        .returning({ id: friendRequests.id });
    });
    for (const request of requests) {
      for (const id of [userId, targetId]) {
        await this.deps.bus.userEvent(id, 'FRIEND_REQUEST_DELETE', { id: request.id });
      }
    }
    await this.afterBlockChange(userId, targetId);
  }

  async unblock(userId: string, targetId: string): Promise<void> {
    await this.db
      .delete(userBlocks)
      .where(and(eq(userBlocks.blockerId, userId), eq(userBlocks.blockedId, targetId)));
    await this.afterBlockChange(userId, targetId);
  }

  private async afterBlockChange(userId: string, targetId: string): Promise<void> {
    const guildId = await this.conversationOf(userId, targetId);
    if (guildId) {
      await this.deps.bus.sync(guildId);
      await this.deps.voice.enforce(guildId);
    }
    await this.deps.bus.userEvent(userId, 'BLOCKS_UPDATE', {
      userIds: await this.blockedIds(userId),
    });
  }

  private async shareServer(a: string, b: string): Promise<boolean> {
    const mine = this.db
      .select({ guildId: guildMembers.guildId })
      .from(guildMembers)
      .innerJoin(guilds, eq(guilds.id, guildMembers.guildId))
      .where(and(eq(guildMembers.userId, a), eq(guilds.kind, 'server')));
    const [row] = await this.db
      .select({ guildId: guildMembers.guildId })
      .from(guildMembers)
      .where(and(eq(guildMembers.userId, b), inArray(guildMembers.guildId, mine)))
      .limit(1);
    return Boolean(row);
  }
}
