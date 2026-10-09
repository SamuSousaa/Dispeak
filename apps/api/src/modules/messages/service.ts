import {
  EVERYONE_MENTION,
  extractMentions,
  hasPermission,
  Permissions,
  type Message,
  type MessagePage,
} from '@frequencia/shared';
import { and, desc, eq, lt } from 'drizzle-orm';
import { schema, type Database } from '../../db/client';
import { forbidden, notFound } from '../../errors';
import type { GatewayBus } from '../../gateway/bus';
import { uuidv7 } from '../../lib/ids';
import {
  canViewChannel,
  channelPermissionsOf,
  loadGuildSnapshot,
  type GuildSnapshot,
} from '../guilds/snapshot';

const { messages, channels, users } = schema;

type MessageRow = typeof messages.$inferSelect;
type AuthorRow = Pick<typeof users.$inferSelect, 'id' | 'username' | 'displayName'>;

const authorColumns = { id: users.id, username: users.username, displayName: users.displayName };

/** Text chat: history with cursor pagination, plus the events that keep clients live. */
export class MessageService {
  constructor(
    private readonly db: Database,
    private readonly bus: GatewayBus,
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
      messages: page.map((row) => toMessage(row.message, row.author, snapshot.guild.id)),
      nextCursor: rows.length > options.limit ? (page[0]?.message.id ?? null) : null,
    };
  }

  async send(userId: string, channelId: string, content: string): Promise<Message> {
    const { snapshot, permissions } = await this.access(
      userId,
      channelId,
      Permissions.SendMessages,
    );
    const [row] = await this.db
      .insert(messages)
      .values({
        id: uuidv7(),
        channelId,
        authorId: userId,
        content,
        ...this.resolveMentions(snapshot, channelId, content, permissions),
      })
      .returning();
    if (!row) throw new Error('message insert returned nothing');

    const message = toMessage(row, this.authorOf(snapshot, userId), snapshot.guild.id);
    await this.bus.event(snapshot.guild.id, 'MESSAGE_CREATE', message, channelId);
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

    const [row] = await this.db
      .update(messages)
      .set({
        content,
        editedAt: new Date(),
        ...this.resolveMentions(snapshot, existing.channelId, content, permissions),
      })
      .where(eq(messages.id, messageId))
      .returning();
    if (!row) throw notFound('message');

    const message = toMessage(row, this.authorOf(snapshot, userId), snapshot.guild.id);
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
    await this.db.delete(messages).where(eq(messages.id, messageId));
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
    if (row.type !== 'text') throw notFound('text channel');
    const permissions = channelPermissionsOf(snapshot, userId, channelId);
    if (!hasPermission(permissions, permission)) throw forbidden();
    return { snapshot, permissions };
  }

  private async find(messageId: string): Promise<MessageRow> {
    const [row] = await this.db.select().from(messages).where(eq(messages.id, messageId));
    if (!row) throw notFound('message');
    return row;
  }

  /**
   * Keeps only mentions that mean something: members who can actually see the channel, and
   * the everyone-mention only from authors allowed to use it.
   */
  private resolveMentions(
    snapshot: GuildSnapshot,
    channelId: string,
    content: string,
    authorPermissions: bigint,
  ): Pick<MessageRow, 'mentions' | 'mentionEveryone'> {
    return {
      mentions: extractMentions(content).filter(
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
    return { id: member.userId, username: member.username, displayName: member.displayName };
  }
}

function toMessage(row: MessageRow, author: AuthorRow, guildId: string): Message {
  return {
    id: row.id,
    channelId: row.channelId,
    guildId,
    author: { id: author.id, username: author.username, displayName: author.displayName },
    content: row.content,
    mentions: row.mentions,
    mentionEveryone: row.mentionEveryone,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
  };
}
