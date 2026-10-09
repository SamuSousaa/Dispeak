import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { createLogger } from '../src/logger';
import { WorkerPool } from '../src/worker-pool';

describe('WorkerPool', () => {
  let pool: WorkerPool;

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      MEDIA_NUM_WORKERS: '2',
      RTC_ANNOUNCED_ADDRESSES: '127.0.0.1',
      RTC_MIN_PORT: '41000',
      RTC_MAX_PORT: '41010',
    });
    pool = await WorkerPool.create(config, createLogger(config));
  });

  afterAll(() => pool.close());

  it('spawns the configured number of workers', () => {
    expect(pool.size).toBe(2);
  });

  it('hands out the least loaded worker', () => {
    const first = pool.leastLoaded();
    first.routers += 1;
    const second = pool.leastLoaded();
    expect(second.index).not.toBe(first.index);
    first.routers -= 1;
  });
});
