import type { AuthResponse } from '@frequencia/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { hashRefreshToken } from '../src/modules/auth/tokens';
import { createTestApp, refreshCookieOf, type TestApp } from './helpers/app';

describe('authentication', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  const unique = () => `user_${Math.random().toString(36).slice(2, 12)}`;

  describe('register', () => {
    it('creates an account, returns an access token and sets the refresh cookie', async () => {
      const username = unique();
      const response = await t.request('POST', '/auth/register', {
        body: { username, displayName: 'Alice', password: 'correct horse battery' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<AuthResponse>();
      expect(body.user).toMatchObject({ username, displayName: 'Alice' });
      expect(body.expiresIn).toBe(900);
      expect(body.accessToken.split('.')).toHaveLength(3);

      const cookie = response.cookies.find((entry) => entry.name === 'fq_refresh');
      expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api/auth' });
      expect(cookie?.value.length).toBeGreaterThan(40);
    });

    it('stores an argon2id hash, never the password', async () => {
      const account = await t.account();
      const [row] = await t.app.ctx.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, account.user.id));
      expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
      expect(row?.passwordHash).not.toContain(account.password);
    });

    it('normalises the username and rejects duplicates', async () => {
      const username = unique();
      const body = { username: username.toUpperCase(), password: 'correct horse battery' };
      const first = await t.request('POST', '/auth/register', { body });
      expect(first.json<AuthResponse>().user.username).toBe(username);

      const second = await t.request('POST', '/auth/register', { body: { ...body, username } });
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ error: 'username_taken' });
    });

    it('validates the payload', async () => {
      const cases = [
        { username: 'ab', password: 'correct horse battery' },
        { username: 'has spaces', password: 'correct horse battery' },
        { username: unique(), password: 'short' },
        { password: 'correct horse battery' },
      ];
      for (const body of cases) {
        const response = await t.request('POST', '/auth/register', { body });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: 'invalid_request' });
      }
    });
  });

  describe('login', () => {
    it('accepts the right password', async () => {
      const account = await t.account();
      const response = await t.request('POST', '/auth/login', {
        body: { username: account.user.username, password: account.password },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<AuthResponse>().user.id).toBe(account.user.id);
      expect(refreshCookieOf(response)).not.toBe('');
    });

    it('gives the same answer for a wrong password and an unknown user', async () => {
      const account = await t.account();
      const wrongPassword = await t.request('POST', '/auth/login', {
        body: { username: account.user.username, password: 'not the password' },
      });
      const unknownUser = await t.request('POST', '/auth/login', {
        body: { username: unique(), password: account.password },
      });
      for (const response of [wrongPassword, unknownUser]) {
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({
          error: 'invalid_credentials',
          message: 'invalid username or password',
        });
        expect(refreshCookieOf(response)).toBe('');
      }
    });
  });

  describe('access token', () => {
    it('identifies the user', async () => {
      const account = await t.account('Alice');
      const response = await t.request('GET', '/users/@me', { token: account.token });
      expect(response.json()).toEqual(account.user);
    });

    it('is required and must be valid', async () => {
      const missing = await t.request('GET', '/users/@me');
      const garbage = await t.request('GET', '/users/@me', { token: 'not.a.token' });
      for (const response of [missing, garbage]) {
        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({ error: 'unauthorized' });
      }
    });

    it('expires', async () => {
      const short = await createTestApp({ ACCESS_TOKEN_TTL_SECONDS: '1' });
      try {
        const account = await short.account();
        await new Promise((resolve) => setTimeout(resolve, 2100));
        const response = await short.request('GET', '/users/@me', { token: account.token });
        expect(response.statusCode).toBe(401);
      } finally {
        await short.close();
      }
    });
  });

  describe('refresh', () => {
    it('rotates the refresh token and issues a new access token', async () => {
      const account = await t.account();
      const response = await t.request('POST', '/auth/refresh', { cookie: account.cookie });

      expect(response.statusCode).toBe(200);
      const rotated = refreshCookieOf(response);
      expect(rotated).not.toBe('');
      expect(rotated).not.toBe(account.cookie);
      const me = await t.request('GET', '/users/@me', {
        token: response.json<AuthResponse>().accessToken,
      });
      expect(me.statusCode).toBe(200);
    });

    it('requires the cookie', async () => {
      const response = await t.request('POST', '/auth/refresh');
      expect(response.statusCode).toBe(401);
    });

    it('rejects unknown tokens', async () => {
      const response = await t.request('POST', '/auth/refresh', { cookie: 'fq_refresh=forged' });
      expect(response.statusCode).toBe(401);
    });

    it('tolerates two tabs refreshing at the same time', async () => {
      const account = await t.account();
      const [a, b] = await Promise.all([
        t.request('POST', '/auth/refresh', { cookie: account.cookie }),
        t.request('POST', '/auth/refresh', { cookie: account.cookie }),
      ]);
      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    });

    it('treats a replayed token as theft and revokes the whole session', async () => {
      const account = await t.account();
      const rotated = await t.request('POST', '/auth/refresh', { cookie: account.cookie });
      const current = refreshCookieOf(rotated);

      // Move the rotation into the past, beyond the concurrent-refresh grace period.
      const oldToken = account.cookie.split('=')[1] ?? '';
      await t.app.ctx.db
        .update(schema.refreshTokens)
        .set({ revokedAt: new Date(Date.now() - 60_000) })
        .where(eq(schema.refreshTokens.tokenHash, hashRefreshToken(oldToken)));

      const replay = await t.request('POST', '/auth/refresh', { cookie: account.cookie });
      expect(replay.statusCode).toBe(401);

      // The legitimate holder of the newest token is logged out too.
      const legit = await t.request('POST', '/auth/refresh', { cookie: current });
      expect(legit.statusCode).toBe(401);
      const me = await t.request('GET', '/users/@me', {
        token: rotated.json<AuthResponse>().accessToken,
      });
      expect(me.statusCode).toBe(401);
    });

    it('rejects expired refresh tokens', async () => {
      const account = await t.account();
      const token = account.cookie.split('=')[1] ?? '';
      await t.app.ctx.db
        .update(schema.refreshTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.refreshTokens.tokenHash, hashRefreshToken(token)));
      const response = await t.request('POST', '/auth/refresh', { cookie: account.cookie });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('logout and revocation', () => {
    it('revokes the refresh token and the access tokens of that session', async () => {
      const account = await t.account();
      const logout = await t.request('POST', '/auth/logout', { cookie: account.cookie });
      expect(logout.statusCode).toBe(204);
      expect(logout.cookies.find((entry) => entry.name === 'fq_refresh')?.value).toBe('');

      expect(
        (await t.request('POST', '/auth/refresh', { cookie: account.cookie })).statusCode,
      ).toBe(401);
      expect((await t.request('GET', '/users/@me', { token: account.token })).statusCode).toBe(401);
    });

    it('leaves other sessions of the same user alone', async () => {
      const account = await t.account();
      const second = await t.request('POST', '/auth/login', {
        body: { username: account.user.username, password: account.password },
      });
      await t.request('POST', '/auth/logout', { cookie: account.cookie });

      const me = await t.request('GET', '/users/@me', {
        token: second.json<AuthResponse>().accessToken,
      });
      expect(me.statusCode).toBe(200);
    });

    it('logout-all ends every session', async () => {
      const account = await t.account();
      const second = await t.request('POST', '/auth/login', {
        body: { username: account.user.username, password: account.password },
      });
      const response = await t.request('POST', '/auth/logout-all', { token: account.token });
      expect(response.statusCode).toBe(204);

      for (const token of [account.token, second.json<AuthResponse>().accessToken]) {
        expect((await t.request('GET', '/users/@me', { token })).statusCode).toBe(401);
      }
      for (const cookie of [account.cookie, refreshCookieOf(second)]) {
        expect((await t.request('POST', '/auth/refresh', { cookie })).statusCode).toBe(401);
      }
    });
  });

  describe('rate limiting', () => {
    it('throttles credential endpoints per client address', async () => {
      const limited = await createTestApp({ RATE_LIMIT_AUTH_MAX: '3' });
      try {
        const attempt = (ip: string) =>
          limited.request('POST', '/auth/login', {
            ip,
            body: { username: unique(), password: 'whatever it is' },
          });
        const statuses = [];
        for (let i = 0; i < 5; i++) statuses.push((await attempt('203.0.113.7')).statusCode);
        expect(statuses).toEqual([401, 401, 401, 429, 429]);

        const blocked = await attempt('203.0.113.7');
        expect(blocked.json()).toMatchObject({ error: 'rate_limited' });
        expect(blocked.headers['retry-after']).toBeDefined();

        // Another client is not affected.
        expect((await attempt('203.0.113.8')).statusCode).toBe(401);
      } finally {
        await limited.close();
      }
    });
  });
});
