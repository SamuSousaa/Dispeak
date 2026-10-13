import { z } from 'zod';

const schema = z.object({
  /** Where the web app is served. The desktop app is a window onto it. */
  DISPEAKER_URL: z.url().default('https://dispeaker.duckdns.org'),
  /** Where the update feed is (`latest.yml` and the installers). Defaults to `/download/` of the app. */
  DISPEAKER_UPDATE_URL: z.url().optional(),
  /** Opens the developer tools with the window. */
  DISPEAKER_DEVTOOLS: z.stringbool().default(false),
  /**
   * The ffmpeg behind the experimental native capture. Defaults to the one the capture
   * benchmark downloaded.
   */
  DISPEAKER_FFMPEG: z.string().min(1).optional(),
});

const env = schema.parse(process.env);

export const config = {
  appUrl: new URL(env.DISPEAKER_URL),
  updateUrl: env.DISPEAKER_UPDATE_URL ?? new URL('/download/', env.DISPEAKER_URL).href,
  devtools: env.DISPEAKER_DEVTOOLS,
  ffmpeg: env.DISPEAKER_FFMPEG,
} as const;
