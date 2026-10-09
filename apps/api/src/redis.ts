import { Redis } from 'ioredis';

export type { Redis };

export interface RedisHandle {
  /** General purpose connection: commands and publishing. */
  redis: Redis;
  /** Dedicated connection in subscriber mode. */
  subscriber: Redis;
  close: () => Promise<void>;
}

export function connectRedis(url: string): RedisHandle {
  const options = { maxRetriesPerRequest: 3, lazyConnect: false };
  const redis = new Redis(url, options);
  const subscriber = new Redis(url, options);
  // Without a listener ioredis prints connection errors to stderr on its own.
  redis.on('error', () => undefined);
  subscriber.on('error', () => undefined);
  return {
    redis,
    subscriber,
    close: async () => {
      await Promise.allSettled([redis.quit(), subscriber.quit()]);
    },
  };
}
