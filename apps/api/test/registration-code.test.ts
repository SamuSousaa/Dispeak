import type { AuthResponse, RegistrationInfo } from '@frequencia/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers/app';

const CODE = 'so-os-amigos-2026';
const unique = () => `user_${Math.random().toString(36).slice(2, 12)}`;
const body = (accessCode?: string) => ({
  username: unique(),
  password: 'correct horse battery',
  ...(accessCode === undefined ? {} : { accessCode }),
});

describe('registration behind an access code', () => {
  let open: TestApp;
  let closed: TestApp;

  beforeAll(async () => {
    open = await createTestApp();
    closed = await createTestApp({ REGISTRATION_CODE: CODE });
  });

  afterAll(async () => {
    await open.close();
    await closed.close();
  });

  it('tells a visitor whether the server asks for a code', async () => {
    const free = await open.request('GET', '/auth/registration');
    expect(free.json<RegistrationInfo>()).toEqual({ accessCodeRequired: false });
    const locked = await closed.request('GET', '/auth/registration');
    expect(locked.json<RegistrationInfo>()).toEqual({ accessCodeRequired: true });
  });

  it('ignores the code on a server that does not ask for one', async () => {
    expect((await open.request('POST', '/auth/register', { body: body() })).statusCode).toBe(200);
    const extra = await open.request('POST', '/auth/register', { body: body('anything') });
    expect(extra.statusCode).toBe(200);
  });

  it('refuses an account without the code, or with a wrong one', async () => {
    for (const attempt of [body(), body(''), body('so-os-amigos-2025'), body(`${CODE} `)]) {
      const response = await closed.request('POST', '/auth/register', { body: attempt });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: 'access_code_invalid' });
    }
  });

  it('creates the account with the right code, and lets it sign in like any other', async () => {
    const account = body(CODE);
    const created = await closed.request('POST', '/auth/register', { body: account });
    expect(created.statusCode).toBe(200);
    expect(created.json<AuthResponse>().user.username).toBe(account.username);

    const login = await closed.request('POST', '/auth/login', {
      body: { username: account.username, password: account.password },
    });
    expect(login.statusCode).toBe(200);
  });
});
