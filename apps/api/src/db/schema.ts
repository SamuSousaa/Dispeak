import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  /** Lowercase, unique login handle. */
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  /** File id of the profile picture. */
  avatarId: uuid('avatar_id'),
  /** File id of the picture on top of the profile card. */
  bannerId: uuid('banner_id'),
  bio: text('bio'),
  customStatus: text('custom_status'),
  /** `#rrggbb`. */
  accentColor: text('accent_color'),
  /** `online`, `idle`, `dnd` or `invisible`: how the user chose to be seen. */
  presenceMode: text('presence_mode').notNull().default('online'),
  passwordHash: text('password_hash').notNull(),
  createdAt: createdAt(),
});

/**
 * Rotating refresh tokens. Every login starts a family; each refresh revokes the presented
 * token and issues the next one of the same family. Presenting a revoked token means it was
 * stolen (or replayed), and revokes the whole family.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    /** SHA-256 of the token; the token itself is never stored. */
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (table) => [
    index('refresh_tokens_user_idx').on(table.userId),
    index('refresh_tokens_family_idx').on(table.familyId),
  ],
);

export const guilds = pgTable('guilds', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  /** File id of the server icon. */
  iconId: uuid('icon_id'),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
});

export const guildMembers = pgTable(
  'guild_members',
  {
    guildId: uuid('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    nickname: text('nickname'),
    /** Silenced by a moderator in every voice channel of the guild. */
    serverMuted: boolean('server_muted').notNull().default(false),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.userId] }),
    index('guild_members_user_idx').on(table.userId),
  ],
);

export const roles = pgTable(
  'roles',
  {
    /** The @everyone role of a guild uses the guild id. */
    id: uuid('id').primaryKey(),
    guildId: uuid('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    permissions: bigint('permissions', { mode: 'bigint' }).notNull(),
    /** Rank in the hierarchy: higher outranks lower, @everyone is 0. */
    position: integer('position').notNull(),
    /** `#rrggbb` for the names of its members. */
    color: text('color'),
    createdAt: createdAt(),
  },
  (table) => [index('roles_guild_idx').on(table.guildId)],
);

export const memberRoles = pgTable(
  'member_roles',
  {
    guildId: uuid('guild_id').notNull(),
    userId: uuid('user_id').notNull(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.userId, table.roleId] }),
    // Leaving or being kicked drops the member's roles with the membership.
    foreignKey({
      columns: [table.guildId, table.userId],
      foreignColumns: [guildMembers.guildId, guildMembers.userId],
    }).onDelete('cascade'),
  ],
);

/** People removed from a guild who may not rejoin. */
export const guildBans = pgTable(
  'guild_bans',
  {
    guildId: uuid('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bannedBy: uuid('banned_by').notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId] })],
);

export const channelType = pgEnum('channel_type', ['text', 'voice', 'category', 'thread']);

export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey(),
    guildId: uuid('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    type: channelType('type').notNull(),
    name: text('name').notNull(),
    topic: text('topic'),
    /** Order among the siblings of the same parent. */
    position: integer('position').notNull(),
    /** Category this channel sits in; for a thread, the text channel it hangs from. */
    parentId: uuid('parent_id'),
    createdAt: createdAt(),
  },
  (table) => [
    index('channels_guild_idx').on(table.guildId),
    foreignKey({ columns: [table.parentId], foreignColumns: [table.id] }).onDelete('set null'),
  ],
);

export const overwriteTarget = pgEnum('overwrite_target', ['role', 'member']);

export const channelOverwrites = pgTable(
  'channel_overwrites',
  {
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    targetType: overwriteTarget('target_type').notNull(),
    /** Role id or user id, depending on `targetType`. */
    targetId: uuid('target_id').notNull(),
    allow: bigint('allow', { mode: 'bigint' }).notNull(),
    deny: bigint('deny', { mode: 'bigint' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.targetId] })],
);

export const invites = pgTable(
  'invites',
  {
    code: text('code').primaryKey(),
    guildId: uuid('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    creatorId: uuid('creator_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `null` means unlimited. */
    maxUses: integer('max_uses'),
    uses: integer('uses').notNull().default(0),
    /** `null` means it never expires. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [index('invites_guild_idx').on(table.guildId)],
);

export const messages = pgTable(
  'messages',
  {
    /** UUIDv7: sorts by creation time, so it doubles as the pagination cursor. */
    id: uuid('id').primaryKey(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    /** Users mentioned with `<@id>`, resolved when the message was written. */
    mentions: uuid('mentions')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    mentionEveryone: boolean('mention_everyone').notNull().default(false),
    /** The message this one answers; cleared when that message is deleted. */
    replyToId: uuid('reply_to_id'),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    // One index serves "latest messages of a channel" and "older than cursor".
    index('messages_channel_idx').on(table.channelId, table.id.desc()),
    foreignKey({ columns: [table.replyToId], foreignColumns: [table.id] }).onDelete('set null'),
  ],
);

export const messageReactions = pgTable(
  'message_reactions',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.messageId, table.userId, table.emoji] })],
);

/** A poll carried by a message. */
export const polls = pgTable('polls', {
  messageId: uuid('message_id')
    .primaryKey()
    .references(() => messages.id, { onDelete: 'cascade' }),
  question: text('question').notNull(),
  multiple: boolean('multiple').notNull().default(false),
});

export const pollOptions = pgTable(
  'poll_options',
  {
    id: uuid('id').primaryKey(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    text: text('text').notNull(),
  },
  (table) => [index('poll_options_message_idx').on(table.messageId)],
);

export const pollVotes = pgTable(
  'poll_votes',
  {
    optionId: uuid('option_id')
      .notNull()
      .references(() => pollOptions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.optionId, table.userId] }),
    index('poll_votes_message_idx').on(table.messageId),
  ],
);

/** How far each user has read each text channel. */
export const readStates = pgTable(
  'read_states',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    /** A UUIDv7 cursor: every message with a greater id is unread. */
    lastReadId: uuid('last_read_id').notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.channelId] })],
);

export const attachments = pgTable(
  'attachments',
  {
    /** Random UUID; also the name of the file on disk. */
    id: uuid('id').primaryKey(),
    /** `null` between the upload and the message that uses it. */
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    uploaderId: uuid('uploader_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Order inside the message. */
    position: integer('position').notNull().default(0),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    width: integer('width'),
    height: integer('height'),
    createdAt: createdAt(),
  },
  (table) => [index('attachments_message_idx').on(table.messageId)],
);

/** Notification sounds the owner chose for a guild, one per event. */
export const guildSounds = pgTable(
  'guild_sounds',
  {
    guildId: uuid('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    /** One of `GUILD_SOUND_EVENTS`. */
    event: text('event').notNull(),
    /** Random UUID naming the file on disk; a new one for every upload. */
    fileId: uuid('file_id').notNull(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.event] })],
);
