import pino, { type Logger } from 'pino';
import type { Config } from './config';

export type { Logger };

export function createLogger(config: Pick<Config, 'env' | 'logLevel'>): Logger {
  return pino({
    level: config.env === 'test' ? 'silent' : config.logLevel,
    ...(config.env === 'development'
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
      : {}),
  });
}
