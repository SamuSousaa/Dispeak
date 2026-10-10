import type os from 'node:os';
import { describe, expect, it } from 'vitest';
import { detectLanAddress, loadConfig } from '../src/config';

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

  it('prefers a private address over a VPN adapter listed first', () => {
    const ipv4 = (address: string, internal = false): os.NetworkInterfaceInfo => ({
      address,
      netmask: '255.255.255.0',
      family: 'IPv4',
      mac: '00:00:00:00:00:00',
      internal,
      cidr: `${address}/24`,
    });
    expect(
      detectLanAddress({
        lo: [ipv4('127.0.0.1', true)],
        vpn: [ipv4('26.225.141.48')],
        ethernet: [ipv4('192.168.18.167')],
      }),
    ).toBe('192.168.18.167');
    expect(detectLanAddress({ vpn: [ipv4('26.225.141.48')] })).toBe('26.225.141.48');
    expect(detectLanAddress({ lo: [ipv4('127.0.0.1', true)] })).toBeUndefined();
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
