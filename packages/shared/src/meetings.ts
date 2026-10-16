import { z } from 'zod';

/**
 * Meetings: a call outside any server, reached by a link. Whoever opens the link asks to come
 * in and someone already inside lets them in; people without an account come in with just a
 * name. A meeting exists while its call does: when nobody has been in it for a little while,
 * or its host ends it, it is gone with everything said in it (ADR 0017).
 */

/** The meeting's id is its link: 22 characters of base64url, 128 random bits. */
export const meetingIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

/** The name a person goes by in a meeting. */
export const meetingNameSchema = z.string().trim().min(1).max(32);

/**
 * What proves a person was let in (or asked to be): their id and a secret, joined by a dot.
 * Kept by the browser, sent in the `x-meeting-key` header and in the socket's hello.
 */
export const meetingKeySchema = z.string().min(1).max(200);
export const MEETING_KEY_HEADER = 'x-meeting-key';

/** The media service room of a meeting. */
export const meetingRoom = (meetingId: string) => `meet:${meetingId}`;

/** Seconds a meeting outlives its call: room for someone whose connection dropped. */
export const MEETING_EMPTY_GRACE_SECONDS = 120;
/** People let into one meeting, and people waiting at its door. */
export const MEETING_MAX_PARTICIPANTS = 25;
export const MEETING_MAX_WAITING = 20;

export const meetingParticipantSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The account behind the person; `null` for a guest. */
  userId: z.string().nullable(),
  host: z.boolean(),
  /** The host took their microphone: they hear, but nobody hears them. */
  mutedByHost: z.boolean(),
  /** In the call right now. */
  inCall: z.boolean(),
});
export type MeetingParticipant = z.infer<typeof meetingParticipantSchema>;

export const meetingKnockSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Whether the person has an account (a guest is anyone with a name). */
  hasAccount: z.boolean(),
  at: z.iso.datetime(),
});
export type MeetingKnock = z.infer<typeof meetingKnockSchema>;

export const meetingMessageContentSchema = z.string().trim().min(1).max(2000);

export const meetingMessageSchema = z.object({
  id: z.string(),
  participantId: z.string(),
  name: z.string(),
  content: z.string(),
  at: z.iso.datetime(),
});
export type MeetingMessage = z.infer<typeof meetingMessageSchema>;

/** What anyone with the link may know: that it exists, and whose it is. */
export const meetingPreviewSchema = z.object({
  id: meetingIdSchema,
  hostName: z.string(),
});
export type MeetingPreview = z.infer<typeof meetingPreviewSchema>;

/** What someone inside sees. */
export const meetingStateSchema = meetingPreviewSchema.extend({
  /** The person asking. */
  selfId: z.string(),
  participants: z.array(meetingParticipantSchema),
  waiting: z.array(meetingKnockSchema),
  /** The latest messages, oldest first. */
  messages: z.array(meetingMessageSchema),
});
export type MeetingState = z.infer<typeof meetingStateSchema>;

// --- REST -----------------------------------------------------------------------------------

/** A new meeting: its id, and the key of its host. */
export const meetingCreatedSchema = z.object({ id: meetingIdSchema, key: meetingKeySchema });
export type MeetingCreated = z.infer<typeof meetingCreatedSchema>;

/** Asking to come in. A signed-in user goes by their own name; a guest gives one. */
export const meetingKnockRequestSchema = z.object({ name: meetingNameSchema.optional() });

/**
 * The answer to a knock: wait at the door (with the key that hears the answer), or come in
 * straight away (the host, from another device).
 */
export const meetingKnockResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('waiting'), requestKey: meetingKeySchema }),
  z.object({ status: z.literal('admitted'), key: meetingKeySchema }),
]);
export type MeetingKnockResponse = z.infer<typeof meetingKnockResponseSchema>;

/** The host mutes someone for everyone, or gives their microphone back. */
export const meetingMuteRequestSchema = z.object({ muted: z.boolean() });

export const meetingMessageRequestSchema = z.object({ content: meetingMessageContentSchema });

// --- socket -------------------------------------------------------------------------------------

/** Path of a meeting's socket, under the API prefix. */
export const meetingSocketPath = (meetingId: string) => `/meetings/${meetingId}/socket`;
export const MEETING_SOCKET_ROUTE = '/meetings/:meetingId/socket';

/** The first and only frame a client sends: who it is, inside or at the door. */
export const meetingHelloSchema = z.union([
  z.object({ t: z.literal('hello'), key: meetingKeySchema }),
  z.object({ t: z.literal('hello'), requestKey: meetingKeySchema }),
]);
export type MeetingHello = z.infer<typeof meetingHelloSchema>;

export const meetingServerFrameSchema = z.discriminatedUnion('t', [
  /** To someone inside: everything, on hello and whenever the people change. */
  z.object({ t: z.literal('state'), d: meetingStateSchema }),
  /** To someone inside: a new message. */
  z.object({ t: z.literal('message'), d: meetingMessageSchema }),
  /** To someone at the door: let in, with the key to come in with. */
  z.object({ t: z.literal('admitted'), d: z.object({ key: meetingKeySchema }) }),
  /** To someone at the door: turned away. */
  z.object({ t: z.literal('denied') }),
  /**
   * The meeting is over for this person: it ended, the key is no good (`gone`), or the host
   * took them out (`removed`).
   */
  z.object({
    t: z.literal('ended'),
    d: z.object({ reason: z.enum(['ended', 'gone', 'removed']) }),
  }),
]);
export type MeetingServerFrame = z.infer<typeof meetingServerFrameSchema>;
