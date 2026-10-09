import {
  bigint,
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

export const channelType = pgEnum('channel_type', ['text', 'voice', 'category']);

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
    /** Category this channel sits in. */
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
