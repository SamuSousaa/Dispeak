import { z } from 'zod';

export const nicknameSchema = z
  .string()
  .trim()
  .min(2)
  .max(24)
  .regex(/^[\p{L}\p{N} _.-]+$/u, 'only letters, numbers, spaces and _ . - are allowed');

export const iceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof iceServerSchema>;

export const empty = z.object({});
