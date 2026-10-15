import { z } from 'zod';
import {
  channelSchema,
  friendRequestSchema,
  guildSchema,
  idSchema,
  memberSchema,
  messageSchema,
  presenceStatusSchema,
  selfSchema,
} from './api';
import { userSettingsSchema } from './user-settings';

/**
 * Realtime gateway protocol, modelled after Discord's: every frame is `{ op, d?, s?, t? }`.
 * Server pushes are `Dispatch` frames carrying an event name `t` and a sequence number `s`
 * that the client echoes in heartbeats and uses to resume after a dropped connection.
 */
export const GATEWAY_PATH = '/gateway';

export const GatewayOp = {
  /** server -> client: an event (`t`, `s`, `d`). */
  Dispatch: 0,
  /** client -> server: keep-alive carrying the last sequence number received. */
  Heartbeat: 1,
  /** client -> server: start a new session with an access token. */
  Identify: 2,
  /** client -> server: continue a previous session, replaying missed events. */
  Resume: 6,
  /** server -> client: the session cannot be resumed (or identify failed softly). */
  InvalidSession: 9,
  /** server -> client: first frame, announces the heartbeat interval. */
  Hello: 10,
  /** server -> client: heartbeat acknowledged. */
  HeartbeatAck: 11,
} as const;

export const GatewayCloseCode = {
  DecodeError: 4002,
  NotAuthenticated: 4003,
  AuthenticationFailed: 4004,
  AlreadyAuthenticated: 4005,
  RateLimited: 4008,
  SessionTimedOut: 4009,
} as const;

// --- client -> server -----------------------------------------------------------------------

export const gatewayClientFrameSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal(GatewayOp.Heartbeat), d: z.number().int().nullable() }),
  z.object({ op: z.literal(GatewayOp.Identify), d: z.object({ token: z.string().max(4096) }) }),
  z.object({
    op: z.literal(GatewayOp.Resume),
    d: z.object({
      token: z.string().max(4096),
      sessionId: z.string().max(64),
      seq: z.number().int().nonnegative(),
    }),
  }),
]);
export type GatewayClientFrame = z.infer<typeof gatewayClientFrameSchema>;

// --- dispatch events ------------------------------------------------------------------------

const guildRef = z.object({ guildId: idSchema });

export const gatewayEvents = {
  /** First event of a new session: who you are and every guild you belong to. */
  READY: z.object({
    sessionId: z.string(),
    user: selfSchema,
    /** Preferences of the account, the same on every device. */
    settings: userSettingsSchema,
    guilds: z.array(guildSchema),
  }),
  /** A resumed session has replayed everything it missed. */
  RESUMED: z.object({}),

  /** The user joined (or created) a guild. */
  GUILD_CREATE: guildSchema,
  /** Full replacement of a guild, sent when permissions may have changed what is visible. */
  GUILD_SYNC: guildSchema,
  GUILD_UPDATE: z.object({ id: idSchema, name: z.string(), icon: idSchema.nullable() }),
  /** The guild was deleted, or the user left it or was kicked. */
  GUILD_DELETE: z.object({ id: idSchema }),

  CHANNEL_CREATE: channelSchema,
  CHANNEL_UPDATE: channelSchema,
  CHANNEL_DELETE: z.object({ id: idSchema, guildId: idSchema }),

  MEMBER_ADD: guildRef.extend({ member: memberSchema }),
  MEMBER_UPDATE: guildRef.extend({ member: memberSchema }),
  MEMBER_REMOVE: guildRef.extend({ userId: idSchema }),

  PRESENCE_UPDATE: z.object({ userId: idSchema, status: presenceStatusSchema }),

  /** `channelId: null` means the user left voice. */
  VOICE_STATE_UPDATE: guildRef.extend({
    userId: idSchema,
    channelId: idSchema.nullable(),
    muted: z.boolean(),
    deafened: z.boolean(),
    streaming: z.boolean(),
  }),

  MESSAGE_CREATE: messageSchema,
  MESSAGE_UPDATE: messageSchema,
  MESSAGE_DELETE: z.object({ id: idSchema, channelId: idSchema, guildId: idSchema }),
  /** A friend request was made, to or by the user. */
  FRIEND_REQUEST_CREATE: friendRequestSchema,
  /** A friend request is gone: accepted, declined or withdrawn. */
  FRIEND_REQUEST_DELETE: z.object({ id: idSchema }),

  /** The account's preferences changed, on this device or another one: all of them. */
  USER_SETTINGS_UPDATE: userSettingsSchema,

  /** Someone started typing in a text channel; clients expire it after a few seconds. */
  TYPING_START: z.object({ guildId: idSchema, channelId: idSchema, userId: idSchema }),
} as const;

export type GatewayEventName = keyof typeof gatewayEvents;
export type GatewayEventData<T extends GatewayEventName> = z.infer<(typeof gatewayEvents)[T]>;
/** What a publisher passes in: before defaults and transforms are applied. */
export type GatewayEventInput<T extends GatewayEventName> = z.input<(typeof gatewayEvents)[T]>;

// --- server -> client -----------------------------------------------------------------------

export type GatewayDispatchFrame = {
  [T in GatewayEventName]: { op: 0; s: number; t: T; d: GatewayEventData<T> };
}[GatewayEventName];

export type GatewayServerFrame =
  | GatewayDispatchFrame
  | { op: 9; d: { resumable: boolean } }
  | { op: 10; d: { heartbeatInterval: number } }
  | { op: 11 };

/** Loose envelope check; the payload is validated per event with `gatewayEvents[t]`. */
export const gatewayServerFrameSchema = z.object({
  op: z.number().int(),
  d: z.unknown().optional(),
  s: z.number().int().optional(),
  t: z.string().optional(),
});
