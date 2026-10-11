import { z } from 'zod';

const schema = z.object({
  /** Where the web app is served. The desktop app is a window onto it. */
  DISPEAKER_URL: z.url().default('https://dispeaker.duckdns.org'),
  /** Opens the developer tools with the window. */
  DISPEAKER_DEVTOOLS: z.stringbool().default(false),
});

const env = schema.parse(process.env);

export const config = {
  appUrl: new URL(env.DISPEAKER_URL),
  devtools: env.DISPEAKER_DEVTOOLS,
} as const;
