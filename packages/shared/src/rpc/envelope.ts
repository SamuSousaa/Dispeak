import { z } from 'zod';

/**
 * Wire format shared by every signaling channel (lab P2P, voice, internal API <-> media RPC).
 * Three frame kinds travel in both directions: requests, their responses, and one-way events.
 */
export const rpcErrorSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().max(512),
});

export const rpcRequestFrameSchema = z.object({
  t: z.literal('req'),
  id: z.number().int().nonnegative(),
  method: z.string().min(1).max(64),
  data: z.unknown().optional(),
});

export const rpcResponseFrameSchema = z.discriminatedUnion('ok', [
  z.object({
    t: z.literal('res'),
    id: z.number().int().nonnegative(),
    ok: z.literal(true),
    data: z.unknown().optional(),
  }),
  z.object({
    t: z.literal('res'),
    id: z.number().int().nonnegative(),
    ok: z.literal(false),
    error: rpcErrorSchema,
  }),
]);

export const rpcEventFrameSchema = z.object({
  t: z.literal('evt'),
  event: z.string().min(1).max(64),
  data: z.unknown().optional(),
});

export const rpcFrameSchema = z.union([
  rpcRequestFrameSchema,
  rpcResponseFrameSchema,
  rpcEventFrameSchema,
]);

export type RpcErrorPayload = z.infer<typeof rpcErrorSchema>;
export type RpcRequestFrame = z.infer<typeof rpcRequestFrameSchema>;
export type RpcResponseFrame = z.infer<typeof rpcResponseFrameSchema>;
export type RpcEventFrame = z.infer<typeof rpcEventFrameSchema>;
export type RpcFrame = z.infer<typeof rpcFrameSchema>;

/** Error codes produced by the RPC layer itself. Protocols add their own. */
export const RpcErrorCode = {
  UnknownMethod: 'unknown_method',
  InvalidPayload: 'invalid_payload',
  InvalidResponse: 'invalid_response',
  Internal: 'internal_error',
  Timeout: 'timeout',
  Closed: 'closed',
} as const;

export class RpcError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'RpcError';
  }
}
