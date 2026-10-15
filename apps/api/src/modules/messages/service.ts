import { randomUUID } from 'node:crypto';
import type { ReadStream } from 'node:fs';
import {
  ATTACHMENT_MAX_BYTES,
  EVERYONE_MENTION,
  extractMentions,
  hasPermission,
  Permissions,
  type Attachment,
  REACTION_MAX_PER_MESSAGE,
  type CreatePoll,
  type Poll,
  REPLY_EXCERPT_LENGTH,
  type Message,
  type MessagePage,
  type MessageReference,
  type Reaction,
  type UnreadChannel,
} from '@frequencia/shared';
import { and, asc, desc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { schema, type Database } from '../../db/client';
import type { ConversationService } from '../conversations/service';
import { badRequest, forbidden, notFound } from '../../errors';
import type { GatewayBus } from '../../gateway/bus';
import { cleanFilename } from '../../lib/filename';
import { publicUserColumns, toPublicUser, type PublicUserRow } from '../../lib/user';
import { uuidv7 } from '../../lib/ids';
import { sniffImage } from '../../lib/image';
import {
  canViewChannel,
  channelPermissionsOf,
  loadGuildSnapshot,
  type GuildSnapshot,
} from '../guilds/snapshot';
import type { AttachmentFiles } from './attachment-files';

const {
  messages,
  channels,
  users,
  attachments,
  messageReactions,
  readStates,
  guildMembers,
  polls,
  pollOptions,
  pollVotes,
} = schema;

type MessageRow = typeof messages.$inferSelect;
type AttachmentRow = typeof attachments.$inferSelect;
type AuthorRow = PublicUserRow;
type MessageWithAuthor = { message: MessageRow; author: AuthorRow };

const authorColumns = publicUserColumns;
const toAuthor = toPublicUser;

/** An upload must be used in a message within this time, or it is discarded. */
const UNATTACHED_TTL_MS = 60 * 60 * 1000;

/** Text chat: history with cursor pagination, plus the events that keep clients live. */
export class MessageService {
  constructor(
    private readonly db: Database,
    private readonly bus: GatewayBus,
    private readonly files: AttachmentFiles,
    /** Private conversations: a message may answer or show a message request. */
    private readonly conversations?: Pick<ConversationService, 'afterMessage'>,
  ) {}

  /**
   * One page of history, oldest first. `before` is the id of the oldest message the client
   * already has; because ids are time-ordered the page is a single index range scan.
   */
  async list(
    userId: string,
    channelId: string,
    options: { before?: string; limit: number },
  ): Promise<MessagePage> {
    const { snapshot } = await this.access(userId, channelId, Permissions.ViewChannel);
    const rows = await this.db
      .select({ message: messages, author: authorColumns })
      .from(messages)
      .innerJoin(users, eq(users.id, messages.authorId))
      .where(
        and(
          eq(messages.channelId, channelId),
          options.before ? lt(messages.id, options.before) : undefined,
        ),
      )
      .orderBy(desc(messages.id))
      // One extra row tells whether an older page exists.
      .limit(options.limit + 1);

    const page = rows.slice(0, options.limit).reverse();
    return {
      messages: await this.present(page, snapshot.guild.id),
      nextCursor: rows.length > options.limit ? (page[0]?.message.id ?? null) : null,
    };
  }

  async send(
    userId: string,
    channelId: string,
    content: string,
    attachmentIds: string[] = [],
    replyToId: string | null = null,
    poll: CreatePoll | null = null,
  ): Promise<Message> {
    const { snapshot, permissions } = await this.access(
      userId,
      channelId,
      Permissions.SendMessages,
    );
    const ids = [...new Set(attachmentIds)];
    if (ids.length > 0 && !hasPermission(permissions, Permissions.AttachFiles)) throw forbidden();
    const repliedAuthorId = replyToId ? await this.authorOfReply(replyToId, channelId) : null;
    if (replyToId && !repliedAuthorId) throw badRequest('unknown message to reply to');

    const row = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(messages)
        .values({
          id: uuidv7(),
          channelId,
          authorId: userId,
          content,
          replyToId,
          ...this.resolveMentions(snapshot, channelId, content, permissions, repliedAuthorId),
        })
        .returning();
      if (!inserted) throw new Error('message insert returned nothing');

      // Only the uploader's own, still unused uploads to this very channel can be attached.
      for (const [position, id] of ids.entries()) {
        const [attachment] = await tx
          .update(attachments)
          .set({ messageId: inserted.id, position })
          .where(
            and(
              eq(attachments.id, id),
              eq(attachments.uploaderId, userId),
              eq(attachments.channelId, channelId),
              isNull(attachments.messageId),
            ),
          )
          .returning();
        if (!attachment) throw badRequest('unknown or already used attachment');
      }
      if (poll) {
        await tx.insert(polls).values({
          messageId: inserted.id,
          question: poll.question,
          multiple: poll.multiple ?? false,
        });
        await tx.insert(pollOptions).values(
          poll.options.map((text, position) => ({
            id: uuidv7(),
            messageId: inserted.id,
            position,
            text,
          })),
        );
      }
      return inserted;
    });

    const message = await this.one(
      { message: row, author: this.authorOf(snapshot, userId) },
      snapshot.guild.id,
    );
    await this.bus.event(snapshot.guild.id, 'MESSAGE_CREATE', message, channelId);
    if (snapshot.dm) await this.conversations?.afterMessage(snapshot, userId);
    return message;
  }

  /** Only the author may edit; mentions are recomputed from the new content. */
  async edit(userId: string, messageId: string, content: string): Promise<Message> {
    const existing = await this.find(messageId);
    const { snapshot, permissions } = await this.access(
      userId,
      existing.channelId,
      Permissions.ViewChannel,
    );
    if (existing.authorId !== userId) throw forbidden('only the author can edit a message');
    const attached = (await this.attachmentsOf([messageId])).get(messageId) ?? [];
    if (!content && attached.length === 0 && !(await this.pollsOf([messageId])).has(messageId)) {
      throw badRequest('a message needs text');
    }

    const repliedAuthorId = existing.replyToId
      ? await this.authorOfReply(existing.replyToId, existing.channelId)
      : null;
    const [row] = await this.db
      .update(messages)
      .set({
        content,
        editedAt: new Date(),
        ...this.resolveMentions(
          snapshot,
          existing.channelId,
          content,
          permissions,
          repliedAuthorId,
        ),
      })
      .where(eq(messages.id, messageId))
      .returning();
    if (!row) throw notFound('message');

    const message = await this.one(
      { message: row, author: this.authorOf(snapshot, userId) },
      snapshot.guild.id,
    );
    await this.bus.event(snapshot.guild.id, 'MESSAGE_UPDATE', message, existing.channelId);
    return message;
  }

  /** Authors delete their own messages; MANAGE_MESSAGES deletes anyone's. */
  async delete(userId: string, messageId: string): Promise<void> {
    const existing = await this.find(messageId);
    const { snapshot, permissions } = await this.access(
      userId,
      existing.channelId,
      Permissions.ViewChannel,
    );
    if (existing.authorId !== userId && !hasPermission(permissions, Permissions.ManageMessages)) {
      throw forbidden();
    }
    const attached = (await this.attachmentsOf([messageId])).get(messageId) ?? [];
    await this.db.delete(messages).where(eq(messages.id, messageId));
    await this.files.remove(attached.map((attachment) => attachment.id));
    await this.bus.event(
      snapshot.guild.id,
      'MESSAGE_DELETE',
      { id: messageId, channelId: existing.channelId, guildId: snapshot.guild.id },
      existing.channelId,
    );
  }

  async typing(userId: string, channelId: string): Promise<void> {
    const { snapshot } = await this.access(userId, channelId, Permissions.SendMessages);
    await this.bus.event(
      snapshot.guild.id,
      'TYPING_START',
      { guildId: snapshot.guild.id, channelId, userId },
      channelId,
    );
  }

  // --- polls --------------------------------------------------------------------------------

  /** Replaces the user's vote in a poll with the given options (none takes it back). */
  async vote(userId: string, messageId: string, optionIds: string[]): Promise<Message> {
    const existing = await this.find(messageId);
    const { snapshot } = await this.access(userId, existing.channelId, Permissions.ViewChannel);
    const [poll] = await this.db.select().from(polls).where(eq(polls.messageId, messageId));
    if (!poll) throw notFound('poll');
    const options = await this.db
      .select({ id: pollOptions.id })
      .from(pollOptions)
      .where(eq(pollOptions.messageId, messageId));
    const wanted = [...new Set(optionIds)];
    if (wanted.some((id) => !options.some((option) => option.id === id))) {
      throw badRequest('unknown option');
    }
    if (!poll.multiple && wanted.length > 1) throw badRequest('this poll takes one answer');

    await this.db.transaction(async (tx) => {
      await tx
        .delete(pollVotes)
        .where(and(eq(pollVotes.messageId, messageId), eq(pollVotes.userId, userId)));
      if (wanted.length > 0) {
        await tx
          .insert(pollVotes)
          .values(wanted.map((optionId) => ({ optionId, userId, messageId })));
      }
    });
    return this.reactionsChanged(existing, snapshot.guild.id, true);
  }

  // --- reactions ----------------------------------------------------------------------------

  /** Anyone who can see the channel may react; a message takes a limited variety of emojis. */
  async react(userId: string, messageId: string, emoji: string): Promise<Message> {
    const existing = await this.find(messageId);
    const { snapshot } = await this.access(userId, existing.channelId, Permissions.AddReactions);
    const used = await this.db
      .selectDistinct({ emoji: messageReactions.emoji })
      .from(messageReactions)
      .where(eq(messageReactions.messageId, messageId));
    if (
      used.length >= REACTION_MAX_PER_MESSAGE &&
      !used.some((reaction) => reaction.emoji === emoji)
    ) {
      throw badRequest('this message has too many different reactions');
    }
    const added = await this.db
      .insert(messageReactions)
      .values({ messageId, userId, emoji })
      .onConflictDoNothing()
      .returning();
    return this.reactionsChanged(existing, snapshot.guild.id, added.length > 0);
  }

  /** Takes back the user's own reaction. */
  async unreact(userId: string, messageId: string, emoji: string): Promise<Message> {
    const existing = await this.find(messageId);
    const { snapshot } = await this.access(userId, existing.channelId, Permissions.ViewChannel);
    const removed = await this.db
      .delete(messageReactions)
      .where(
        and(
          eq(messageReactions.messageId, messageId),
          eq(messageReactions.userId, userId),
          eq(messageReactions.emoji, emoji),
        ),
      )
      .returning();
    return this.reactionsChanged(existing, snapshot.guild.id, removed.length > 0);
  }

  private async reactionsChanged(
    row: MessageRow,
    guildId: string,
    changed: boolean,
  ): Promise<Message> {
    const [author] = await this.db
      .select(authorColumns)
      .from(users)
      .where(eq(users.id, row.authorId));
    if (!author) throw notFound('message');
    const message = await this.one({ message: row, author }, guildId);
    if (changed) await this.bus.event(guildId, 'MESSAGE_UPDATE', message, row.channelId);
    return message;
  }

  // --- unread -------------------------------------------------------------------------------

  /**
   * Channels with messages the user has not read: everything after their read mark or, where
   * they never opened the channel, after they joined the guild. Their own messages do not count.
   */
  async unread(userId: string): Promise<UnreadChannel[]> {
    const rows = await this.db
      .select({
        channelId: messages.channelId,
        guildId: channels.guildId,
        count: sql<number>`count(*)::int`,
        mentions: sql<number>`(count(*) filter (where ${messages.mentionEveryone} or ${userId}::uuid = any(${messages.mentions})))::int`,
      })
      .from(messages)
      .innerJoin(channels, eq(channels.id, messages.channelId))
      .innerJoin(
        guildMembers,
        and(eq(guildMembers.guildId, channels.guildId), eq(guildMembers.userId, userId)),
      )
      .leftJoin(
        readStates,
        and(eq(readStates.channelId, messages.channelId), eq(readStates.userId, userId)),
      )
      .where(
        and(
          ne(messages.authorId, userId),
          sql`case when ${readStates.lastReadId} is not null
                then ${messages.id} > ${readStates.lastReadId}
                else ${messages.createdAt} > ${guildMembers.joinedAt} end`,
        ),
      )
      .groupBy(messages.channelId, channels.guildId);

    // Channels the user can no longer see do not exist for them, unread messages included.
    const snapshots = new Map<string, GuildSnapshot | null>();
    const visible: UnreadChannel[] = [];
    for (const row of rows) {
      if (!snapshots.has(row.guildId)) {
        snapshots.set(row.guildId, await loadGuildSnapshot(this.db, row.guildId));
      }
      const snapshot = snapshots.get(row.guildId);
      if (snapshot && canViewChannel(snapshot, userId, row.channelId)) visible.push(row);
    }
    return visible;
  }

  /** Marks a channel as read up to this moment. */
  async ack(userId: string, channelId: string): Promise<void> {
    await this.access(userId, channelId, Permissions.ViewChannel);
    // Ids are time-ordered, so a fresh one is a cursor past every message that exists.
    const lastReadId = uuidv7();
    await this.db
      .insert(readStates)
      .values({ userId, channelId, lastReadId })
      .onConflictDoUpdate({
        target: [readStates.userId, readStates.channelId],
        set: { lastReadId },
      });
  }

  // --- attachments --------------------------------------------------------------------------

  /**
   * Stores an image to be attached to the user's next message in this channel. The type comes
   * from the bytes themselves; the name is only ever shown, never used as a path.
   */
  async upload(
    userId: string,
    channelId: string,
    filename: string,
    data: Buffer,
  ): Promise<Attachment> {
    await this.access(userId, channelId, Permissions.SendMessages | Permissions.AttachFiles);
    if (data.length === 0 || data.length > ATTACHMENT_MAX_BYTES) {
      throw badRequest('attachment is empty or too large');
    }
    // An image is shown in the conversation; anything else is just a file to download, and
    // is stored and served as opaque bytes whatever its name claims.
    const image = sniffImage(data);

    const id = randomUUID();
    await this.files.write(id, data);
    try {
      const [row] = await this.db
        .insert(attachments)
        .values({
          id,
          channelId,
          uploaderId: userId,
          filename: cleanFilename(filename, image ? 'imagem' : 'arquivo'),
          contentType: image?.contentType ?? 'application/octet-stream',
          size: data.length,
          width: image?.width ?? null,
          height: image?.height ?? null,
        })
        .returning();
      if (!row) throw new Error('attachment insert returned nothing');
      return toAttachment(row);
    } catch (error) {
      await this.files.remove([id]);
      throw error;
    }
  }

  /**
   * An attachment for download. It follows the visibility of its channel, checked on every
   * request; an upload not yet in a message is visible only to whoever sent it.
   */
  async download(
    userId: string,
    attachmentId: string,
  ): Promise<{ attachment: Attachment; stream: ReadStream }> {
    const [row] = await this.db.select().from(attachments).where(eq(attachments.id, attachmentId));
    if (!row || (!row.messageId && row.uploaderId !== userId)) throw notFound('attachment');
    try {
      await this.access(userId, row.channelId, Permissions.ViewChannel);
    } catch {
      throw notFound('attachment');
    }
    return { attachment: toAttachment(row), stream: this.files.open(row.id) };
  }

  /** Drops uploads that were never used and files left behind by deleted channels or guilds. */
  async sweepAttachments(now: Date = new Date()): Promise<void> {
    await this.sweepUnusedUploads(now);
    await this.sweepOrphanFiles(now);
  }

  /** Uploads that never made it into a message. */
  async sweepUnusedUploads(now: Date = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - UNATTACHED_TTL_MS);
    const abandoned = await this.db
      .delete(attachments)
      .where(and(isNull(attachments.messageId), lt(attachments.createdAt, cutoff)))
      .returning({ id: attachments.id });
    await this.files.remove(abandoned.map((row) => row.id));
  }

  /** Files whose row is gone, because their message, channel or guild was deleted. */
  async sweepOrphanFiles(now: Date = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - UNATTACHED_TTL_MS);
    const stored = await this.files.list(cutoff);
    for (let index = 0; index < stored.length; index += 500) {
      const batch = stored.slice(index, index + 500);
      const known = await this.db
        .select({ id: attachments.id })
        .from(attachments)
        .where(inArray(attachments.id, batch));
      const alive = new Set(known.map((row) => row.id));
      await this.files.remove(batch.filter((id) => !alive.has(id)));
    }
  }

  // --- internals ----------------------------------------------------------------------------

  /** Loads the channel's guild and checks the permission; hidden channels look missing. */
  private async access(userId: string, channelId: string, permission: bigint) {
    const [row] = await this.db
      .select({ guildId: channels.guildId, type: channels.type })
      .from(channels)
      .where(eq(channels.id, channelId));
    const snapshot = row ? await loadGuildSnapshot(this.db, row.guildId) : null;
    if (!row || !snapshot || !canViewChannel(snapshot, userId, channelId)) {
      throw notFound('channel');
    }
    // Voice channels carry a text chat of their own; categories hold no messages.
    if (row.type === 'category') throw notFound('text channel');
    const permissions = channelPermissionsOf(snapshot, userId, channelId);
    if (!hasPermission(permissions, permission)) throw forbidden();
    return { snapshot, permissions };
  }

  private async find(messageId: string): Promise<MessageRow> {
    const [row] = await this.db.select().from(messages).where(eq(messages.id, messageId));
    if (!row) throw notFound('message');
    return row;
  }

  /** Rows as clients see them: with attachments, reactions and the message each one answers. */
  private async present(rows: MessageWithAuthor[], guildId: string): Promise<Message[]> {
    const ids = rows.map((row) => row.message.id);
    const replyIds = rows.flatMap((row) => (row.message.replyToId ? [row.message.replyToId] : []));
    const [attached, reactions, references, pollsById] = await Promise.all([
      this.attachmentsOf(ids),
      this.reactionsOf(ids),
      this.referencesOf(replyIds),
      this.pollsOf(ids),
    ]);
    return rows.map(({ message, author }) => ({
      id: message.id,
      channelId: message.channelId,
      guildId,
      author: toAuthor(author),
      content: message.content,
      attachments: (attached.get(message.id) ?? []).map(toAttachment),
      reactions: reactions.get(message.id) ?? [],
      replyTo: (message.replyToId && references.get(message.replyToId)) || null,
      poll: pollsById.get(message.id) ?? null,
      mentions: message.mentions,
      mentionEveryone: message.mentionEveryone,
      createdAt: message.createdAt.toISOString(),
      editedAt: message.editedAt?.toISOString() ?? null,
    }));
  }

  private async one(row: MessageWithAuthor, guildId: string): Promise<Message> {
    const [message] = await this.present([row], guildId);
    if (!message) throw notFound('message');
    return message;
  }

  private async pollsOf(messageIds: string[]): Promise<Map<string, Poll>> {
    const byMessage = new Map<string, Poll>();
    if (messageIds.length === 0) return byMessage;
    const found = await this.db.select().from(polls).where(inArray(polls.messageId, messageIds));
    if (found.length === 0) return byMessage;
    const withPoll = found.map((poll) => poll.messageId);
    const [options, votes] = await Promise.all([
      this.db
        .select()
        .from(pollOptions)
        .where(inArray(pollOptions.messageId, withPoll))
        .orderBy(asc(pollOptions.position)),
      this.db
        .select()
        .from(pollVotes)
        .where(inArray(pollVotes.messageId, withPoll))
        .orderBy(asc(pollVotes.createdAt)),
    ]);
    for (const poll of found) {
      byMessage.set(poll.messageId, {
        question: poll.question,
        multiple: poll.multiple,
        options: options
          .filter((option) => option.messageId === poll.messageId)
          .map((option) => ({
            id: option.id,
            text: option.text,
            voterIds: votes
              .filter((vote) => vote.optionId === option.id)
              .map((vote) => vote.userId),
          })),
      });
    }
    return byMessage;
  }

  private async reactionsOf(messageIds: string[]): Promise<Map<string, Reaction[]>> {
    const byMessage = new Map<string, Reaction[]>();
    if (messageIds.length === 0) return byMessage;
    const rows = await this.db
      .select()
      .from(messageReactions)
      .where(inArray(messageReactions.messageId, messageIds))
      .orderBy(asc(messageReactions.createdAt));
    for (const row of rows) {
      const list = byMessage.get(row.messageId) ?? [];
      const reaction = list.find((entry) => entry.emoji === row.emoji);
      if (reaction) reaction.userIds.push(row.userId);
      else list.push({ emoji: row.emoji, userIds: [row.userId] });
      byMessage.set(row.messageId, list);
    }
    return byMessage;
  }

  private async referencesOf(messageIds: string[]): Promise<Map<string, MessageReference>> {
    const byId = new Map<string, MessageReference>();
    if (messageIds.length === 0) return byId;
    const [rows, attached] = await Promise.all([
      this.db
        .select({ message: messages, author: authorColumns })
        .from(messages)
        .innerJoin(users, eq(users.id, messages.authorId))
        .where(inArray(messages.id, messageIds)),
      this.attachmentsOf(messageIds),
    ]);
    for (const { message, author } of rows) {
      byId.set(message.id, {
        id: message.id,
        author: toAuthor(author),
        content: message.content.slice(0, REPLY_EXCERPT_LENGTH),
        attachments: attached.get(message.id)?.length ?? 0,
      });
    }
    return byId;
  }

  /** Author of the message being answered, when it belongs to this channel. */
  private async authorOfReply(messageId: string, channelId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ authorId: messages.authorId })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.channelId, channelId)));
    return row?.authorId ?? null;
  }

  /** Attachments of the given messages, each list in display order. */
  private async attachmentsOf(messageIds: string[]): Promise<Map<string, AttachmentRow[]>> {
    const byMessage = new Map<string, AttachmentRow[]>();
    if (messageIds.length === 0) return byMessage;
    const rows = await this.db
      .select()
      .from(attachments)
      .where(inArray(attachments.messageId, messageIds))
      .orderBy(asc(attachments.position));
    for (const row of rows) {
      if (!row.messageId) continue;
      byMessage.set(row.messageId, [...(byMessage.get(row.messageId) ?? []), row]);
    }
    return byMessage;
  }

  /**
   * Keeps only mentions that mean something: members who can actually see the channel, and
   * the everyone-mention only from authors allowed to use it. Answering someone mentions them.
   */
  private resolveMentions(
    snapshot: GuildSnapshot,
    channelId: string,
    content: string,
    authorPermissions: bigint,
    repliedAuthorId: string | null = null,
  ): Pick<MessageRow, 'mentions' | 'mentionEveryone'> {
    const candidates = new Set(extractMentions(content));
    if (repliedAuthorId) candidates.add(repliedAuthorId);
    return {
      mentions: [...candidates].filter(
        (id) => snapshot.members.has(id) && canViewChannel(snapshot, id, channelId),
      ),
      mentionEveryone:
        content.includes(EVERYONE_MENTION) &&
        hasPermission(authorPermissions, Permissions.MentionEveryone),
    };
  }

  private authorOf(snapshot: GuildSnapshot, userId: string): AuthorRow {
    const member = snapshot.members.get(userId);
    if (!member) throw notFound('member');
    return member.row;
  }
}

function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.contentType,
    size: row.size,
    width: row.width,
    height: row.height,
  };
}
