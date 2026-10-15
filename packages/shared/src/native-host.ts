import { z } from 'zod';

/**
 * What the desktop app and its Windows helper (`dispeaker-host`, Rust) say to each other, one
 * JSON line at a time: requests with an id and their answers, and events while a watch is on.
 * See apps/desktop/native/host.
 */

export const hostAnswerSchema = z.union([
  z.object({ id: z.number().int(), result: z.unknown() }),
  z.object({ id: z.number().int(), error: z.string() }),
]);

export const hostEventSchema = z.object({ event: z.string(), data: z.unknown() });

export const hostForegroundSchema = z
  .object({
    handle: z.number().int(),
    processId: z.number().int().nonnegative(),
    /** The window takes its whole monitor: a game, a film, a presentation. */
    coversScreen: z.boolean(),
  })
  .nullable();
export type HostForeground = z.infer<typeof hostForegroundSchema>;

export const hostTimersSchema = z.object({ done: z.array(z.number().int()) });

/** Use of each engine (`<engine id>|<type>`), summed over the processes, 0 to 100 each. */
export const hostGpuSchema = z.object({
  app: z.record(z.string(), z.number()),
  all: z.record(z.string(), z.number()),
});

export const gameSourceSchema = z.enum(['steam', 'epic', 'xbox', 'gog', 'added', 'fullscreen']);
export type GameSource = z.infer<typeof gameSourceSchema>;

export const runningGameSchema = z.object({
  pid: z.number().int(),
  name: z.string().max(200),
  /** File name of the program, lowercase: how the user's choices refer to it. */
  exe: z.string().max(260),
  path: z.string().max(1024),
  /** Where it was recognised: a launcher, the user's own list, or a full-screen guess. */
  source: gameSourceSchema,
  /** The window to share; `null` while the game has none yet. */
  windowHandle: z.number().int().nullable(),
  fullscreen: z.boolean(),
});
export type RunningGame = z.infer<typeof runningGameSchema>;

export const hostGamesSchema = z.array(runningGameSchema);

export const runningWindowSchema = z.object({
  exe: z.string().max(260),
  title: z.string().max(500),
  path: z.string().max(1024),
});
export type RunningWindow = z.infer<typeof runningWindowSchema>;

export const hostWindowsSchema = z.array(runningWindowSchema);
