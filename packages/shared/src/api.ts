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
