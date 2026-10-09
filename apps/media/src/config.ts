import os from 'node:os';
import { DEFAULT_MEDIA_PORT } from '@frequencia/shared';
import { z } from 'zod';

const port = z.coerce.number().int().min(0).max(65535);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MEDIA_HOST: z.string().default('0.0.0.0'),
  MEDIA_PORT: port.default(DEFAULT_MEDIA_PORT),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MEDIA_NUM_WORKERS: z.coerce.number().int().min(1).optional(),
  RTC_LISTEN_IP: z.string().default('0.0.0.0'),
  RTC_ANNOUNCED_ADDRESSES: z.string().optional(),
  RTC_MIN_PORT: port.default(40000),
  RTC_MAX_PORT: port.default(40100),
});

export interface Config {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: string;
  numWorkers: number;
  rtc: {
    listenIp: string;
    announcedAddresses: string[];
    minPort: number;
    maxPort: number;
  };
}

/** First non-internal IPv4 address of the host, used to reach the SFU from other LAN devices. */
export function detectLanAddress(): string | undefined {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${z.prettifyError(parsed.error)}`);
  }
  const data = parsed.data;

  const explicit = (data.RTC_ANNOUNCED_ADDRESSES ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const lan = detectLanAddress();
  const announcedAddresses = explicit.length > 0 ? explicit : ['127.0.0.1', ...(lan ? [lan] : [])];

  const numWorkers = data.MEDIA_NUM_WORKERS ?? os.availableParallelism();
  const portsNeeded = numWorkers * announcedAddresses.length;
  const portsAvailable = data.RTC_MAX_PORT - data.RTC_MIN_PORT + 1;
  if (portsAvailable < portsNeeded) {
    throw new Error(
      `RTC port range ${data.RTC_MIN_PORT}-${data.RTC_MAX_PORT} holds ${portsAvailable} ports, ` +
        `but ${numWorkers} workers x ${announcedAddresses.length} announced addresses need ${portsNeeded}`,
    );
  }

  return {
    env: data.NODE_ENV,
    host: data.MEDIA_HOST,
    port: data.MEDIA_PORT,
    logLevel: data.LOG_LEVEL,
    numWorkers,
    rtc: {
      listenIp: data.RTC_LISTEN_IP,
      announcedAddresses,
      minPort: data.RTC_MIN_PORT,
      maxPort: data.RTC_MAX_PORT,
    },
  };
}
