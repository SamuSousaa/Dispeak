import {
  ApiErrorCode,
  type FriendRequest,
  type Guild,
  type SendFriendRequestResponse,
} from '@frequencia/shared';
import { and, eq, or } from 'drizzle-orm';
import { schema, type Database } from '../../db/client';
import { AppError, badRequest, conflict, notFound } from '../../errors';
import type { GatewayBus } from '../../gateway/bus';
import { uuidv7 } from '../../lib/ids';
import { publicUserColumns, toPublicUser, type PublicUserRow } from '../../lib/user';
import { pairOf, type ConversationService } from '../conversations/service';

const { users, friendRequests, friendships, dmRequests } = schema;

type RequestRow = typeof friendRequests.$inferSelect;

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
  conversations: ConversationService;
}

/**
 * Friendships. One is asked for by username and, once accepted, comes with the private
 * conversation of the pair (the one they may already have, or a new one). Ending it keeps the
 * conversation: what was said stays (ADR 0015).
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
    const { conversations } = this.deps;
    if (await conversations.isBlockedBetween(userId, target.id)) {
      throw new AppError(403, ApiErrorCode.Blocked, 'one of you blocks the other');
    }
    if (await conversations.areFriends(userId, target.id)) {
      throw conflict('you are already friends');
    }

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

    const { conversations } = this.deps;
    const [low, high] = pairOf(row.fromId, row.toId);
    const { guildId, created } = await this.db.transaction(async (tx) => {
      await tx
        .delete(friendRequests)
        .where(
          or(
            and(eq(friendRequests.fromId, row.fromId), eq(friendRequests.toId, row.toId)),
            and(eq(friendRequests.fromId, row.toId), eq(friendRequests.toId, row.fromId)),
          ),
        );
      await tx.insert(friendships).values({ userLow: low, userHigh: high }).onConflictDoNothing();
      const conversation = await conversations.ensure(tx, row.fromId, row.toId);
      // Friends talk freely: a request between them is moot.
      await tx.delete(dmRequests).where(eq(dmRequests.guildId, conversation.guildId));
      return conversation;
    });

    for (const id of [row.fromId, row.toId]) {
      await this.deps.bus.userEvent(id, 'FRIEND_REQUEST_DELETE', { id: row.id });
    }
    if (created) await conversations.announce(guildId, [row.fromId, row.toId]);
    else await this.deps.bus.sync(guildId);
    return conversations.payload(guildId, userId);
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

  /** Ends a friendship. The conversation stays, with everything said in it. */
  async remove(userId: string, friendId: string): Promise<void> {
    const [low, high] = pairOf(userId, friendId);
    const [row] = await this.db
      .delete(friendships)
      .where(and(eq(friendships.userLow, low), eq(friendships.userHigh, high)))
      .returning();
    if (!row) throw notFound('friend');
    const guildId = await this.deps.conversations.conversationOf(userId, friendId);
    if (guildId) await this.deps.bus.sync(guildId);
  }
}
