import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildIceServers } from '../src/lib/ice';
import { createTestApp, type TestApp } from './helpers/app';
import { startFakeMedia, type FakeMedia } from './helpers/fake-media';
import { connectGateway } from './helpers/gateway';

const value = (body: string, metric: string) => {
  const line = body.split('\n').find((entry) => entry.startsWith(metric));
  return line ? Number(line.split(' ').at(-1)) : undefined;
};

describe('GET /metrics', () => {
  let media: FakeMedia;
  let t: TestApp;

  beforeAll(async () => {
    media = await startFakeMedia();
    t = await createTestApp({ MEDIA_INTERNAL_URL: media.url, MEDIA_SHARED_SECRET: media.secret });
  });

  afterAll(async () => {
    await t.close();
    await media.close();
  });

  const scrape = (headers: Record<string, string> = {}) =>
    t.app.inject({ method: 'GET', url: '/metrics', headers });

  it('reports connected users and the state of the media service', async () => {
    const account = await t.account();
    const first = await connectGateway(t.wsUrl);
    const second = await connectGateway(t.wsUrl);
    await first.identify(account.token);
    await second.identify(account.token);
    // Give the media link a moment to come up.
    await expect.poll(() => t.app.ctx.media.connected).toBe(true);

    const response = await scrape();
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    const body = response.body;

    // Two tabs of the same account: two connections, one user.
    expect(value(body, 'frequencia_gateway_connections{')).toBe(2);
    expect(value(body, 'frequencia_gateway_sessions{')).toBe(2);
    expect(value(body, 'frequencia_users_connected{')).toBe(1);

    // Numbers relayed from the media service (see the fake's `stats` handler).
    expect(value(body, 'frequencia_media_link_up{')).toBe(1);
    expect(value(body, 'frequencia_voice_channels_active{')).toBe(2);
    expect(value(body, 'frequencia_voice_participants{')).toBe(5);
    expect(value(body, 'frequencia_media_producers{')).toBe(6);
    expect(value(body, 'frequencia_media_consumers{')).toBe(12);
    expect(value(body, 'frequencia_media_worker_routers{')).toBe(2);
    expect(body).toMatch(/frequencia_media_worker_cpu_seconds_total\{[^}]*mode="user"[^}]*\} 1\.5/);
    expect(body).toContain('frequencia_http_request_duration_seconds_bucket');
    expect(body).toContain('process_resident_memory_bytes');

    await first.close();
    await second.close();
  });

  it('labels requests by route pattern, never by concrete ids', async () => {
    const account = await t.account();
    const guild = await t.createGuild(account);
    await t.request('GET', `/guilds/${guild.id}`, { token: account.token });
    const { body } = await scrape();
    expect(body).toContain('route="/api/guilds/:guildId"');
    expect(body).not.toContain(guild.id);
  });

  it('is not served under the public /api prefix', async () => {
    expect((await t.request('GET', '/metrics')).statusCode).toBe(404);
  });

  it('requires the bearer token when one is configured', async () => {
    const secured = await createTestApp({ METRICS_TOKEN: 'metrics-token-1234567890' });
    try {
      const request = (authorization?: string) =>
        secured.app.inject({
          method: 'GET',
          url: '/metrics',
          headers: authorization ? { authorization } : {},
        });
      expect((await request()).statusCode).toBe(401);
      expect((await request('Bearer wrong-token-wrong-token-1')).statusCode).toBe(401);
      expect((await request('Bearer metrics-token-1234567890')).statusCode).toBe(200);
    } finally {
      await secured.close();
    }
  });
});

describe('ICE servers', () => {
  const base = {
    STUN_URLS: ['stun:stun.example.org:3478'],
    TURN_URLS: ['turn:turn.example.org:3478?transport=udp'],
    TURN_TTL_SECONDS: 3600,
  };

  it('offers only STUN when TURN is not configured', () => {
    expect(buildIceServers(base, 'user-1')).toEqual([{ urls: base.STUN_URLS }]);
    expect(
      buildIceServers({ ...base, TURN_URLS: [], TURN_SECRET: 'secret-secret-secret' }, 'user-1'),
    ).toEqual([{ urls: base.STUN_URLS }]);
  });

  it('mints time-limited TURN credentials in the coturn REST format', () => {
    const now = Date.UTC(2026, 0, 1);
    const [, turn] = buildIceServers(
      { ...base, TURN_SECRET: 'coturn-shared-secret' },
      'user-1',
      now,
    );

    const expiry = now / 1000 + 3600;
    expect(turn?.urls).toEqual(base.TURN_URLS);
    expect(turn?.username).toBe(`${expiry}:user-1`);
    // What coturn computes itself when running with `use-auth-secret`.
    expect(turn?.credential).toBe(
      createHmac('sha1', 'coturn-shared-secret').update(`${expiry}:user-1`).digest('base64'),
    );
  });

  it('hands TURN credentials out together with voice tokens', async () => {
    const app = await createTestApp({
      TURN_URLS: 'turn:turn.example.org:3478',
      TURN_SECRET: 'coturn-shared-secret',
    });
    try {
      const account = await app.account();
      const guild = await app.createGuild(account);
      const voice = guild.channels.find((channel) => channel.type === 'voice');
      const response = await app.request('POST', `/channels/${voice?.id}/voice-token`, {
        token: account.token,
      });
      const { iceServers } = response.json<{
        iceServers: Array<{ urls: string[]; username?: string; credential?: string }>;
      }>();
      expect(iceServers).toHaveLength(2);
      expect(iceServers[1]?.username?.endsWith(`:${account.user.id}`)).toBe(true);
      expect(iceServers[1]?.credential).toBeTruthy();
    } finally {
      await app.close();
    }
  });
});
