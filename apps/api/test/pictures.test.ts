import { readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  PICTURE_MAX_BYTES,
  type Guild,
  type GuildSummary,
  type Message,
  type User,
} from '@frequencia/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type Account, type TestApp } from './helpers/app';
import { connectGateway, type GatewayClient } from './helpers/gateway';

/** A valid 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([3, 0, 2, 0, 0, 0, 0, 0x3b])]);

describe('profile pictures and server icons', () => {
  let t: TestApp;
  let owner: Account;
  let member: Account;
  let outsider: Account;
  const clients: GatewayClient[] = [];

  const upload = (method: 'PUT' | 'DELETE', url: string, account: Account | null, data?: Buffer) =>
    t.app.inject({
      method,
      url: `/api${url}`,
      headers: {
        ...(data ? { 'content-type': 'application/octet-stream' } : {}),
        ...(account ? { authorization: `Bearer ${account.token}` } : {}),
      },
      ...(data ? { payload: data } : {}),
    });
  const image = (id: string) => t.request('GET', `/images/${id}`);
  const storedFiles = () =>
    readdir(path.join(t.app.ctx.config.UPLOADS_DIR, 'pictures')).catch(() => [] as string[]);
  const online = async (account: Account) => {
    const client = await connectGateway(t.wsUrl);
    clients.push(client);
    await client.identify(account.token);
    return client;
  };

  beforeAll(async () => {
    t = await createTestApp();
    [owner, member, outsider] = await Promise.all([
      t.account('Dona'),
      t.account('Membro'),
      t.account('Estranho'),
    ]);
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  afterAll(async () => {
    await t.close();
  });

  it('starts without pictures', async () => {
    const guild = await t.createGuild(owner);
    expect(owner.user.avatar).toBeNull();
    expect(guild.icon).toBeNull();
    expect(guild.members[0]?.user.avatar).toBeNull();
  });

  it('shows a new avatar to everyone who shares a server, and on messages', async () => {
    const guild = await t.createGuild(owner);
    await t.join(guild, owner, member);
    const channelId = guild.channels.find((channel) => channel.type === 'text')?.id ?? '';
    const socket = await online(owner);

    const response = await upload('PUT', '/users/@me/avatar', member, PNG);
    expect(response.statusCode).toBe(200);
    const { avatar } = response.json<User>();
    expect(avatar).toMatch(/^[0-9a-f-]{36}$/);

    const synced = await socket.next('GUILD_SYNC', (data) => data.id === guild.id);
    expect(synced.members.find((entry) => entry.user.id === member.user.id)?.user.avatar).toBe(
      avatar,
    );
    expect(
      (await t.request('GET', '/users/@me', { token: member.token })).json<User>().avatar,
    ).toBe(avatar);

    const sent = await t.request('POST', `/channels/${channelId}/messages`, {
      token: member.token,
      body: { content: 'de cara nova' },
    });
    expect(sent.json<Message>().author.avatar).toBe(avatar);

    // Anyone can fetch it by its id, with nothing that would let it act as a page.
    const served = await image(avatar ?? '');
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['cache-control']).toContain('immutable');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.rawPayload.equals(PNG)).toBe(true);
  });

  it('replaces and removes an avatar without leaving files behind', async () => {
    const first = (await upload('PUT', '/users/@me/avatar', outsider, PNG)).json<User>().avatar;
    const second = (await upload('PUT', '/users/@me/avatar', outsider, GIF)).json<User>().avatar;
    expect(second).not.toBe(first);
    expect((await image(first ?? '')).statusCode).toBe(404);
    expect((await image(second ?? '')).headers['content-type']).toBe('image/gif');
    expect(await storedFiles()).not.toContain(first);

    const removed = await upload('DELETE', '/users/@me/avatar', outsider);
    expect(removed.json<User>().avatar).toBeNull();
    expect((await image(second ?? '')).statusCode).toBe(404);
    expect(await storedFiles()).not.toContain(second);
  });

  it('accepts only small images, from a signed-in user', async () => {
    expect((await upload('PUT', '/users/@me/avatar', null, PNG)).statusCode).toBe(401);
    expect(
      (await upload('PUT', '/users/@me/avatar', owner, Buffer.from('<svg></svg>'))).statusCode,
    ).toBe(400);
    expect(
      (await upload('PUT', '/users/@me/avatar', owner, Buffer.from('MZ not an image'))).statusCode,
    ).toBe(400);
    const huge = Buffer.concat([PNG, Buffer.alloc(PICTURE_MAX_BYTES)]);
    expect((await upload('PUT', '/users/@me/avatar', owner, huge)).statusCode).toBe(413);
    expect((await image('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await image('not-an-id')).statusCode).toBe(400);
  });

  it('lets whoever manages the server set its icon, live for everyone', async () => {
    const guild = await t.createGuild(owner);
    await t.join(guild, owner, member);
    const socket = await online(member);

    expect((await upload('PUT', `/guilds/${guild.id}/icon`, member, PNG)).statusCode).toBe(403);
    expect((await upload('PUT', `/guilds/${guild.id}/icon`, outsider, PNG)).statusCode).toBe(404);

    const response = await upload('PUT', `/guilds/${guild.id}/icon`, owner, PNG);
    expect(response.statusCode).toBe(200);
    const { icon } = response.json<GuildSummary>();
    expect(await socket.next('GUILD_UPDATE')).toEqual({ id: guild.id, name: guild.name, icon });
    expect((await image(icon ?? '')).statusCode).toBe(200);
    expect(
      (await t.request('GET', `/guilds/${guild.id}`, { token: member.token })).json<Guild>().icon,
    ).toBe(icon);

    // Renaming keeps the icon; removing it clears the file.
    const renamed = await t.request('PATCH', `/guilds/${guild.id}`, {
      token: owner.token,
      body: { name: 'Outro nome' },
    });
    expect(renamed.json<GuildSummary>().icon).toBe(icon);
    const removed = await upload('DELETE', `/guilds/${guild.id}/icon`, owner);
    expect(removed.json<GuildSummary>().icon).toBeNull();
    expect((await image(icon ?? '')).statusCode).toBe(404);
  });

  it('drops the icon file with the server', async () => {
    const guild = await t.createGuild(owner);
    const { icon } = (
      await upload('PUT', `/guilds/${guild.id}/icon`, owner, PNG)
    ).json<GuildSummary>();
    expect(await storedFiles()).toContain(icon);
    await t.request('DELETE', `/guilds/${guild.id}`, { token: owner.token });
    expect(await storedFiles()).not.toContain(icon);
  });
});
