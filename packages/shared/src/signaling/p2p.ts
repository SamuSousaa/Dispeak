import { z } from 'zod';
import { defineSide } from '../rpc/peer';
import { empty, iceServerSchema, nicknameSchema } from './common';

/** Lab 1:1 peer-to-peer call. The server only relays SDP and ICE between two peers of a room. */
export const P2P_SIGNALING_PATH = '/lab/p2p';
export const P2P_ROOM_CAPACITY = 2;

export const P2pErrorCode = {
  RoomFull: 'room_full',
  NotInRoom: 'not_in_room',
  AlreadyInRoom: 'already_in_room',
  PeerNotFound: 'peer_not_found',
} as const;

export const p2pRoomIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[a-zA-Z0-9_-]+$/);

export const p2pPeerSchema = z.object({
  id: z.string(),
  nickname: nicknameSchema,
});
export type P2pPeer = z.infer<typeof p2pPeerSchema>;

export const p2pSignalPayloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('description'),
    description: z.object({
      type: z.enum(['offer', 'answer', 'pranswer', 'rollback']),
      sdp: z.string().max(100_000).optional(),
    }),
  }),
  z.object({
    type: z.literal('candidate'),
    candidate: z
      .object({
        candidate: z.string().max(2048),
        sdpMid: z.string().nullable().optional(),
        sdpMLineIndex: z.number().int().nullable().optional(),
        usernameFragment: z.string().nullable().optional(),
      })
      .nullable(),
  }),
]);
export type P2pSignalPayload = z.infer<typeof p2pSignalPayloadSchema>;

/** What the signaling server accepts from a browser. */
export const p2pServerSide = defineSide({
  requests: {
    join: {
      request: z.object({ room: p2pRoomIdSchema, nickname: nicknameSchema }),
      response: z.object({
        self: p2pPeerSchema,
        peers: z.array(p2pPeerSchema),
        iceServers: z.array(iceServerSchema),
      }),
    },
    leave: { request: empty, response: empty },
  },
  events: {
    signal: z.object({ to: z.string(), payload: p2pSignalPayloadSchema }),
  },
});

/** What a browser accepts from the signaling server. */
export const p2pClientSide = defineSide({
  requests: {},
  events: {
    'peer-joined': z.object({ peer: p2pPeerSchema }),
    'peer-left': z.object({ peerId: z.string() }),
    signal: z.object({ from: z.string(), payload: p2pSignalPayloadSchema }),
  },
});
