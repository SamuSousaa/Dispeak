import { z } from 'zod';
import { permissionBitsSchema } from './permissions';

/** REST contracts: request bodies and response payloads of the API. */

export const idSchema = z.uuid();

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(24)
  .regex(/^[a-z0-9_.]+$/, 'only lowercase letters, numbers, _ and . are allowed');

export const passwordSchema = z.string().min(8).max(128);
export const displayNameSchema = z.string().trim().min(1).max(32);

export const userSchema = z.object({
  id: idSchema,
  username: z.string(),
  displayName: z.string(),
});
export type User = z.infer<typeof userSchema>;

// --- auth -----------------------------------------------------------------------------------

export const registerRequestSchema = z.object({
  username: usernameSchema,
  displayName: displayNameSchema.optional(),
  password: passwordSchema,
});
export type RegisterRequest = z.input<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.input<typeof loginRequestSchema>;

export const authResponseSchema = z.object({
  accessToken: z.string(),
  /** Seconds until the access token expires. */
  expiresIn: z.number().int(),
  user: userSchema,
});
export type AuthResponse = z.infer<typeof authResponseSchema>;

// --- guild structure ------------------------------------------------------------------------

export const channelTypeSchema = z.enum(['text', 'voice', 'category']);
export type ChannelType = z.infer<typeof channelTypeSchema>;

export const overwriteSchema = z.object({
  targetType: z.enum(['role', 'member']),
  targetId: idSchema,
  allow: permissionBitsSchema,
  deny: permissionBitsSchema,
});
export type Overwrite = z.infer<typeof overwriteSchema>;

const channelNameSchema = z.string().trim().min(1).max(48);
const channelTopicSchema = z.string().trim().max(256);

export const channelSchema = z.object({
  id: idSchema,
  guildId: idSchema,
  type: channelTypeSchema,
  name: z.string(),
  topic: z.string().nullable(),
  position: z.number().int(),
  /** Category the channel belongs to. */
  parentId: idSchema.nullable(),
  overwrites: z.array(overwriteSchema),
});
export type Channel = z.infer<typeof channelSchema>;

export const roleSchema = z.object({
  /** The @everyone role shares its id with the guild. */
  id: idSchema,
  guildId: idSchema,
  name: z.string(),
  permissions: permissionBitsSchema,
  /** Rank in the hierarchy; higher outranks lower, @everyone is 0. */
  position: z.number().int(),
});
export type Role = z.infer<typeof roleSchema>;

export const memberSchema = z.object({
  user: userSchema,
  nickname: z.string().nullable(),
  /** Roles besides @everyone. */
  roleIds: z.array(idSchema),
  joinedAt: z.iso.datetime(),
});
export type Member = z.infer<typeof memberSchema>;

export const presenceStatusSchema = z.enum(['online', 'offline']);
export type PresenceStatus = z.infer<typeof presenceStatusSchema>;

export const voiceStateSchema = z.object({
  guildId: idSchema,
  channelId: idSchema,
  userId: idSchema,
  muted: z.boolean(),
  deafened: z.boolean(),
  /** Sharing a screen in the channel. */
  streaming: z.boolean(),
});
export type VoiceState = z.infer<typeof voiceStateSchema>;

/** Moments of a voice channel announced with a sound. */
export const GUILD_SOUND_EVENTS = ['join', 'leave', 'streamStart', 'streamStop'] as const;
export const guildSoundEventSchema = z.enum(GUILD_SOUND_EVENTS);
export type GuildSoundEvent = z.infer<typeof guildSoundEventSchema>;

export const GUILD_SOUND_MAX_BYTES = 2 * 1024 * 1024;
/** What the server recognises, from the bytes of the file. */
export const GUILD_SOUND_CONTENT_TYPES = [
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/flac',
  'audio/mp4',
  'audio/webm',
] as const;
export type GuildSoundContentType = (typeof GUILD_SOUND_CONTENT_TYPES)[number];

export const guildSoundSchema = z.object({
  /** Changes whenever the file is replaced, so clients know when to download it again. */
  id: idSchema,
  filename: z.string(),
});
export type GuildSound = z.infer<typeof guildSoundSchema>;

export const uploadGuildSoundQuerySchema = z.object({
  filename: z.string().trim().min(1).max(255),
});

/** A guild as one member sees it: only the channels they can view. */
export const guildSchema = z.object({
  id: idSchema,
  name: z.string(),
  ownerId: idSchema,
  channels: z.array(channelSchema),
  roles: z.array(roleSchema),
  members: z.array(memberSchema),
  /** Ids of the members currently online. */
  onlineUserIds: z.array(idSchema),
  voiceStates: z.array(voiceStateSchema),
  /** Sounds chosen by the owner for everyone in the guild; `null` means the built-in one. */
  sounds: z.object({
    join: guildSoundSchema.nullable(),
    leave: guildSoundSchema.nullable(),
    streamStart: guildSoundSchema.nullable(),
    streamStop: guildSoundSchema.nullable(),
  }),
});
export type Guild = z.infer<typeof guildSchema>;

export const guildSummarySchema = guildSchema.pick({ id: true, name: true, ownerId: true });
export type GuildSummary = z.infer<typeof guildSummarySchema>;

const guildNameSchema = z.string().trim().min(2).max(48);
export const createGuildRequestSchema = z.object({ name: guildNameSchema });
export const updateGuildRequestSchema = z.object({ name: guildNameSchema });

export const createChannelRequestSchema = z.object({
  name: channelNameSchema,
  type: channelTypeSchema,
  parentId: idSchema.nullable().optional(),
});
export type CreateChannelRequest = z.input<typeof createChannelRequestSchema>;

export const updateChannelRequestSchema = z
  .object({
    name: channelNameSchema,
    topic: channelTopicSchema.nullable(),
    parentId: idSchema.nullable(),
  })
  .partial();
export type UpdateChannelRequest = z.input<typeof updateChannelRequestSchema>;

/** New order of channels; positions are assigned from the array order. */
export const reorderChannelsRequestSchema = z.object({
  channels: z
    .array(z.object({ id: idSchema, parentId: idSchema.nullable() }))
    .min(1)
    .max(500),
});
export type ReorderChannelsRequest = z.infer<typeof reorderChannelsRequestSchema>;

export const putOverwriteRequestSchema = overwriteSchema.omit({ targetId: true });
export type PutOverwriteRequest = z.infer<typeof putOverwriteRequestSchema>;

const roleNameSchema = z.string().trim().min(1).max(32);
export const createRoleRequestSchema = z.object({
  name: roleNameSchema,
  permissions: permissionBitsSchema.default('0'),
});
export type CreateRoleRequest = z.input<typeof createRoleRequestSchema>;

export const updateRoleRequestSchema = z
  .object({ name: roleNameSchema, permissions: permissionBitsSchema })
  .partial();
export type UpdateRoleRequest = z.input<typeof updateRoleRequestSchema>;

/** Role ids from the highest rank to the lowest, @everyone excluded. */
export const reorderRolesRequestSchema = z.object({
  roleIds: z.array(idSchema).min(1).max(250),
});

export const updateMemberRequestSchema = z
  .object({
    roleIds: z.array(idSchema).max(250),
    nickname: z.string().trim().min(1).max(32).nullable(),
  })
  .partial();
export type UpdateMemberRequest = z.input<typeof updateMemberRequestSchema>;

// --- invites --------------------------------------------------------------------------------

export const INVITE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export const inviteSchema = z.object({
  code: z.string(),
  guildId: idSchema,
  creatorId: idSchema,
  /** `null` means unlimited. */
  maxUses: z.number().int().nullable(),
  uses: z.number().int(),
  /** `null` means it never expires. */
  expiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type Invite = z.infer<typeof inviteSchema>;

export const createInviteRequestSchema = z.object({
  maxUses: z.number().int().min(1).max(1000).nullable().default(null),
  expiresInSeconds: z.number().int().min(60).max(INVITE_MAX_AGE_SECONDS).nullable().default(null),
});
export type CreateInviteRequest = z.input<typeof createInviteRequestSchema>;

export const invitePreviewSchema = z.object({
  code: z.string(),
  guild: z.object({ id: idSchema, name: z.string(), memberCount: z.number().int() }),
  /** The requesting user already belongs to the guild. */
  alreadyMember: z.boolean(),
});
export type InvitePreview = z.infer<typeof invitePreviewSchema>;

// --- messages ------------------------------------------------------------------------------

export const MESSAGE_MAX_LENGTH = 2000;
export const MESSAGE_PAGE_SIZE = 50;

/** How a user mention is written inside message content: `<@user-id>`. */
export const MENTION_PATTERN = /<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/g;
/** Mentions every member; honoured only with the MENTION_EVERYONE permission. */
export const EVERYONE_MENTION = '@todos';

export const formatMention = (userId: string) => `<@${userId}>`;

/** Ids of the users mentioned in a piece of content, without duplicates. */
export function extractMentions(content: string): string[] {
  return [...new Set([...content.matchAll(MENTION_PATTERN)].map((match) => match[1] as string))];
}

export const messageContentSchema = z.string().trim().min(1).max(MESSAGE_MAX_LENGTH);

export const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
export const ATTACHMENT_MAX_PER_MESSAGE = 4;
/** Images only, identified by their bytes on the server. SVG is left out on purpose. */
export const ATTACHMENT_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;
export type AttachmentContentType = (typeof ATTACHMENT_CONTENT_TYPES)[number];

export const attachmentSchema = z.object({
  id: idSchema,
  filename: z.string(),
  contentType: z.enum(ATTACHMENT_CONTENT_TYPES),
  /** Bytes. */
  size: z.number().int(),
  /** Pixels, when the file header says so; lets clients reserve the space before loading. */
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const uploadAttachmentQuerySchema = z.object({
  filename: z.string().trim().min(1).max(255),
});

export const messageSchema = z.object({
  /** Time-ordered id; also the pagination cursor. */
  id: idSchema,
  channelId: idSchema,
  guildId: idSchema,
  author: userSchema,
  /** May be empty when the message has attachments. */
  content: z.string(),
  attachments: z.array(attachmentSchema),
  /** Members mentioned with `<@id>` who can see the channel. */
  mentions: z.array(idSchema),
  mentionEveryone: z.boolean(),
  createdAt: z.iso.datetime(),
  editedAt: z.iso.datetime().nullable(),
});
export type Message = z.infer<typeof messageSchema>;

const optionalContentSchema = z.string().trim().max(MESSAGE_MAX_LENGTH);

export const sendMessageRequestSchema = z
  .object({
    content: optionalContentSchema.default(''),
    /** Ids returned by the upload endpoint, in display order. */
    attachmentIds: z.array(idSchema).max(ATTACHMENT_MAX_PER_MESSAGE).default([]),
  })
  .refine((value) => value.content.length > 0 || value.attachmentIds.length > 0, {
    message: 'a message needs text or an attachment',
    path: ['content'],
  });
export type SendMessageRequest = z.input<typeof sendMessageRequestSchema>;

/** The text may only be emptied when the message keeps its attachments. */
export const editMessageRequestSchema = z.object({ content: optionalContentSchema });

export const listMessagesQuerySchema = z.object({
  /** Return messages older than this id. */
  before: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(MESSAGE_PAGE_SIZE),
});

export const messagePageSchema = z.object({
  /** Oldest first. */
  messages: z.array(messageSchema),
  /** Pass as `before` to get the previous page; `null` at the beginning of the channel. */
  nextCursor: idSchema.nullable(),
});
export type MessagePage = z.infer<typeof messagePageSchema>;

// --- errors ---------------------------------------------------------------------------------

/** Stable, machine-readable error codes returned as `{ error, message }`. */
export const ApiErrorCode = {
  InvalidRequest: 'invalid_request',
  Unauthorized: 'unauthorized',
  InvalidCredentials: 'invalid_credentials',
  Forbidden: 'forbidden',
  NotFound: 'not_found',
  Conflict: 'conflict',
  UsernameTaken: 'username_taken',
  InviteInvalid: 'invite_invalid',
  RateLimited: 'rate_limited',
  MediaUnavailable: 'media_unavailable',
  Internal: 'internal_error',
} as const;
export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

export const apiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
