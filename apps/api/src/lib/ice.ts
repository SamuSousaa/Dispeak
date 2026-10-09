import { createHmac } from 'node:crypto';
import type { IceServer } from '@frequencia/shared';

export interface IceConfig {
  STUN_URLS: string[];
  TURN_URLS: string[];
  TURN_SECRET?: string;
  TURN_TTL_SECONDS: number;
}

/**
 * ICE servers for one browser. STUN is public; TURN gets short-lived credentials following
 * coturn's REST API scheme (`use-auth-secret`): the username is `<expiry>:<user>`, the
 * password is the HMAC-SHA1 of that username with the secret shared with coturn. Nothing is
 * stored, and a leaked credential stops working when it expires.
 */
export function buildIceServers(
  config: IceConfig,
  userId: string,
  now: number = Date.now(),
): IceServer[] {
  const servers: IceServer[] = [];
  if (config.STUN_URLS.length > 0) servers.push({ urls: config.STUN_URLS });

  if (config.TURN_SECRET && config.TURN_URLS.length > 0) {
    const expiry = Math.floor(now / 1000) + config.TURN_TTL_SECONDS;
    const username = `${expiry}:${userId}`;
    const credential = createHmac('sha1', config.TURN_SECRET).update(username).digest('base64');
    servers.push({ urls: config.TURN_URLS, username, credential });
  }
  return servers;
}
