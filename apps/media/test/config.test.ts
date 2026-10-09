import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('media config', () => {
  it('splits the announced addresses', () => {
    const config = loadConfig({
      MEDIA_NUM_WORKERS: '2',
      RTC_ANNOUNCED_ADDRESSES: '127.0.0.1, 192.168.0.10',
    });
    expect(config.rtc.announcedAddresses).toEqual(['127.0.0.1', '192.168.0.10']);
  });

  it('always announces loopback when nothing is configured', () => {
    const config = loadConfig({ MEDIA_NUM_WORKERS: '1' });
    expect(config.rtc.announcedAddresses[0]).toBe('127.0.0.1');
  });

  it('rejects a port range that cannot hold every worker', () => {
    expect(() =>
      loadConfig({
        MEDIA_NUM_WORKERS: '4',
        RTC_ANNOUNCED_ADDRESSES: '10.0.0.1,10.0.0.2',
        RTC_MIN_PORT: '40000',
        RTC_MAX_PORT: '40003',
      }),
    ).toThrow(/need 8/);
  });
});
