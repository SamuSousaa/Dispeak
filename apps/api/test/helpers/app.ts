import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { AuthResponse, Guild, Invite, Role, User } from '@frequencia/shared';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { inject } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';

export interface Account {
  user: User;
  token: string;
  /** `name=value` of the refresh cookie, ready for a Cookie header. */
  cookie: string;
  password: string;
}

export interface TestApp {
  app: FastifyInstance;
  /** Base ws:// URL of the listening server. */
  wsUrl: string;
  close: () => Promise<void>;
  request: (
    method: InjectOptions['method'],
    url: string,
    options?: { token?: string; body?: unknown; cookie?: string; ip?: string },
  ) => Promise<LightMyRequestResponse>;
  /** Registers a fresh account with a unique username. */
  account: (displayName?: string) => Promise<Account>;
  createGuild: (owner: Account, name?: string) => Promise<Guild>;
  /** Creates an invite as `inviter` and accepts it as `invitee`. */
  join: (guild: Guild, inviter: Account, invitee: Account) => Promise<void>;
  createRole: (
    actor: Account,
    guildId: string,
    name: string,
    permissions?: bigint,
  ) => Promise<Role>;
  setRoles: (actor: Account, guildId: string, target: Account, roleIds: string[]) => Promise<void>;
}

export function refreshCookieOf(response: LightMyRequestResponse): string {
  const cookie = response.cookies.find((entry) => entry.name === 'fq_refresh');
  return cookie ? `${cookie.name}=${cookie.value}` : '';
}

export async function createTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const uploads = await mkdtemp(path.join(tmpdir(), 'frequencia-uploads-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    UPLOADS_DIR: uploads,
    DATABASE_URL: inject('databaseUrl'),
    // Every test file starts its own app, all against one Postgres: with the default pool the
    // files running in parallel can ask for more connections than the server accepts.
    DATABASE_POOL_SIZE: '4',
    REDIS_URL: inject('redisUrl'),
    RUN_MIGRATIONS: 'false',
    // Nothing listens here: the media link just keeps retrying in the background.
    MEDIA_INTERNAL_URL: 'ws://127.0.0.1:9/media/internal',
    MEDIA_SHARED_SECRET: 'test-secret-test-secret-test-secret-1234',
    RATE_LIMIT_MAX: '1000000',
    RATE_LIMIT_AUTH_MAX: '1000000',
    ...env,
  });
  const app = await buildApp(config);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;

  const request: TestApp['request'] = (method, url, options = {}) =>
    app.inject({
      method,
      url: `/api${url}`,
      remoteAddress: options.ip,
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
      ...(options.body === undefined ? {} : { payload: options.body as object }),
    });

  const expectOk = (response: LightMyRequestResponse, what: string) => {
    if (response.statusCode >= 300) {
      throw new Error(`${what} failed: ${response.statusCode} ${response.body}`);
    }
    return response;
  };

  const account: TestApp['account'] = async (displayName) => {
    const password = 'correct horse battery';
    const response = expectOk(
      await request('POST', '/auth/register', {
        body: {
          username: `u${randomUUID().replaceAll('-', '').slice(0, 20)}`,
          displayName,
          password,
        },
      }),
      'register',
    );
    const body = response.json<AuthResponse>();
    // Tests compare this with what other people receive, which leaves the private part out.
    const { presence: _private, ...user } = body.user;
    return {
      user,
      token: body.accessToken,
      cookie: refreshCookieOf(response),
      password,
    };
  };

  const createGuild: TestApp['createGuild'] = async (owner, name = 'Servidor de teste') =>
    expectOk(
      await request('POST', '/guilds', { token: owner.token, body: { name } }),
      'create guild',
    ).json<Guild>();

  const join: TestApp['join'] = async (guild, inviter, invitee) => {
    const invite = expectOk(
      await request('POST', `/guilds/${guild.id}/invites`, { token: inviter.token, body: {} }),
      'create invite',
    ).json<Invite>();
    expectOk(
      await request('POST', `/invites/${invite.code}/accept`, { token: invitee.token }),
      'accept invite',
    );
  };

  const createRole: TestApp['createRole'] = async (actor, guildId, name, permissions = 0n) =>
    expectOk(
      await request('POST', `/guilds/${guildId}/roles`, {
        token: actor.token,
        body: { name, permissions: permissions.toString() },
      }),
      'create role',
    ).json<Role>();

  const setRoles: TestApp['setRoles'] = async (actor, guildId, target, roleIds) => {
    expectOk(
      await request('PATCH', `/guilds/${guildId}/members/${target.user.id}`, {
        token: actor.token,
        body: { roleIds },
      }),
      'set roles',
    );
  };

  return {
    app,
    wsUrl: `ws://127.0.0.1:${port}`,
    close: async () => {
      await app.close();
      await rm(uploads, { recursive: true, force: true });
    },
    request,
    account,
    createGuild,
    join,
    createRole,
    setRoles,
  };
}
