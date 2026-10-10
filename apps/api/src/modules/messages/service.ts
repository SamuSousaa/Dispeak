import { randomUUID } from 'node:crypto';
import type { ReadStream } from 'node:fs';
import {
  ATTACHMENT_MAX_BYTES,
  EVERYONE_MENTION,
  extractMentions,
  hasPermission,
  Permissions,
  type Attachment,
  type AttachmentContentType,
  type Message,
  type MessagePage,
} from '@frequencia/shared';
import { and, asc, desc, eq, inArray, isNull, lt } from 'drizzle-orm';
import { schema, type Database } from '../../db/client';
import { badRequest, forbidden, notFound } from '../../errors';
import type { GatewayBus } from '../../gateway/bus';
import { uuidv7 } from '../../lib/ids';
import { sniffImage } from '../../lib/image';
import {
  canViewChannel,
  channelPermissionsOf,
  loadGuildSnapshot,
  type GuildSnapshot,
} from '../guilds/snapshot';
import type { AttachmentFiles } from './attachment-files';

const { messages, channels, users, attachments } = schema;

type MessageRow = typeof messages.$inferSelect;
type AttachmentRow = typeof attachments.$inferSelect;
type AuthorRow = Pick<typeof users.$inferSelect, 'id' | 'username' | 'displayName'>;

const authorColumns = { id: users.id, username: users.username, displayName: users.displayName };

/** An upload must be used in a message within this time, or it is discarded. */
const UNATTACHED_TTL_MS = 60 * 60 * 1000;

/** Display name of an upload: no path, no control characters. */
function cleanFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const clean = [...base]
    .filter((char) => char >= ' ' && char !== '\u007f')
    .join('')
    .trim();
  return clean.slice(0, 255) || 'imagem';
}

/** Text chat: history with cursor pagination, plus the events that keep clients live. */
export class MessageService {
  constructor(
    private readonly db: Database,
    private readonly bus: GatewayBus,
    private readonly files: AttachmentFiles,
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
    const attached = await this.attachmentsOf(page.map((row) => row.message.id));
    return {
      messages: page.map((row) =>
        toMessage(row.message, row.author, snapshot.guild.id, attached.get(row.message.id)),
      ),
      nextCursor: rows.length > options.limit ? (page[0]?.message.id ?? null) : null,
    };
  }

  async send(
    userId: string,
    channelId: string,
    content: string,
    attachmentIds: string[] = [],
  ): Promise<Message> {
    const { snapshot, permissions } = await this.access(
      userId,
      channelId,
      Permissions.SendMessages,
    );
    const ids = [...new Set(attachmentIds)];

    const { row, attached } = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(messages)
        .values({
          id: uuidv7(),
          channelId,
          authorId: userId,
          content,
          ...this.resolveMentions(snapshot, channelId, content, permissions),
        })
        .returning();
      if (!inserted) throw new Error('message insert returned nothing');

      // Only the uploader's own, still unused uploads to this very channel can be attached.
      const claimed: AttachmentRow[] = [];
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
        claimed.push(attachment);
      }
      return { row: inserted, attached: claimed };
    });

    const message = toMessage(row, this.authorOf(snapshot, userId), snapshot.guild.id, attached);
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
    const attached = (await this.attachmentsOf([messageId])).get(messageId) ?? [];
    if (!content && attached.length === 0) throw badRequest('a message needs text');

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

    const message = toMessage(row, this.authorOf(snapshot, userId), snapshot.guild.id, attached);
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
    await this.access(userId, channelId, Permissions.SendMessages);
    if (data.length === 0 || data.length > ATTACHMENT_MAX_BYTES) {
      throw badRequest('attachment is empty or too large');
    }
    const image = sniffImage(data);
    if (!image) throw badRequest('only PNG, JPEG, GIF and WebP images are accepted');

    const id = randomUUID();
    await this.files.write(id, data);
    try {
      const [row] = await this.db
        .insert(attachments)
        .values({
          id,
          channelId,
          uploaderId: userId,
          filename: cleanFilename(filename),
          contentType: image.contentType,
          size: data.length,
          width: image.width,
          height: image.height,
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
    const cutoff = new Date(now.getTime() - UNATTACHED_TTL_MS);
    const abandoned = await this.db
      .delete(attachments)
      .where(and(isNull(attachments.messageId), lt(attachments.createdAt, cutoff)))
      .returning({ id: attachments.id });
    await this.files.remove(abandoned.map((row) => row.id));

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

function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    filename: row.filename,
    // Only sniffed types are ever stored.
    contentType: row.contentType as AttachmentContentType,
    size: row.size,
    width: row.width,
    height: row.height,
  };
}

function toMessage(
  row: MessageRow,
  author: AuthorRow,
  guildId: string,
  attached: AttachmentRow[] = [],
): Message {
  return {
    id: row.id,
    channelId: row.channelId,
    guildId,
    author: { id: author.id, username: author.username, displayName: author.displayName },
    content: row.content,
    attachments: attached.map(toAttachment),
    mentions: row.mentions,
    mentionEveryone: row.mentionEveryone,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
  };
}
