import type { AuthResponse, Guild, Message, Self } from '@frequencia/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type Account, type TestApp } from './helpers/app';
import { connectGateway, type GatewayClient } from './helpers/gateway';

/** A valid 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('profiles', () => {
  let t: TestApp;
  let owner: Account;
  let member: Account;
  const clients: GatewayClient[] = [];

  const online = async (account: Account) => {
    const client = await connectGateway(t.wsUrl);
    clients.push(client);
    const ready = await client.identify(account.token);
    return { client, ready };
  };
  const patch = (account: Account, body: object) =>
    t.request('PATCH', '/users/@me', { token: account.token, body });
  const guildOf = async (account: Account, guildId: string) =>
    (await t.request('GET', `/guilds/${guildId}`, { token: account.token })).json<Guild>();

  beforeAll(async () => {
    t = await createTestApp();
    [owner, member] = await Promise.all([t.account('Dona'), t.account('Membro')]);
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await patch(member, { presence: 'online' });
  });

  afterAll(async () => {
    await t.close();
  });

  it('starts empty and is filled in piece by piece', async () => {
    expect(member.user).toMatchObject({
      banner: null,
      bio: null,
      customStatus: null,
      accentColor: null,
      status: 'online',
    });
    const guild = await t.createGuild(owner);
    await t.join(guild, owner, member);
    const { client } = await online(owner);

    const response = await patch(member, {
      displayName: 'Membro Novo',
      bio: '  jogo de tudo um pouco  ',
      customStatus: '🎮 até tarde',
      accentColor: '#FF9F1C',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<Self>()).toMatchObject({
      displayName: 'Membro Novo',
      bio: 'jogo de tudo um pouco',
      customStatus: '🎮 até tarde',
      accentColor: '#ff9f1c',
      presence: 'online',
    });

    // Everyone who shares a server sees the new profile, and so do new messages.
    const synced = await client.next('GUILD_SYNC', (data) => data.id === guild.id);
    expect(synced.members.find((entry) => entry.user.id === member.user.id)?.user).toMatchObject({
      displayName: 'Membro Novo',
      bio: 'jogo de tudo um pouco',
    });
    const channelId = guild.channels.find((channel) => channel.type === 'text')?.id ?? '';
    const sent = await t.request('POST', `/channels/${channelId}/messages`, {
      token: member.token,
      body: { content: 'oi' },
    });
    expect(sent.json<Message>().author.customStatus).toBe('🎮 até tarde');

    // Only what is sent changes; empty text clears a field.
    const cleared = await patch(member, { bio: '   ', customStatus: null });
    expect(cleared.json<Self>()).toMatchObject({
      displayName: 'Membro Novo',
      bio: null,
      customStatus: null,
      accentColor: '#ff9f1c',
    });
    expect((await patch(member, {})).statusCode).toBe(200);
  });

  it('validates what it is given', async () => {
    expect((await patch(member, { displayName: '' })).statusCode).toBe(400);
    expect((await patch(member, { bio: 'x'.repeat(191) })).statusCode).toBe(400);
    expect((await patch(member, { customStatus: 'x'.repeat(81) })).statusCode).toBe(400);
    expect((await patch(member, { accentColor: 'red' })).statusCode).toBe(400);
    expect((await patch(member, { presence: 'ghost' })).statusCode).toBe(400);
    expect((await t.request('PATCH', '/users/@me', { body: { bio: 'x' } })).statusCode).toBe(401);
  });

  it('keeps a banner like it keeps a profile picture', async () => {
    const set = await t.app.inject({
      method: 'PUT',
      url: '/api/users/@me/banner',
      headers: {
        'content-type': 'application/octet-stream',
        authorization: `Bearer ${member.token}`,
      },
      payload: PNG,
    });
    expect(set.statusCode).toBe(200);
    const { banner } = set.json<Self>();
    expect((await t.request('GET', `/images/${banner}`)).statusCode).toBe(200);

    const removed = await t.request('DELETE', '/users/@me/banner', { token: member.token });
    expect(removed.json<Self>().banner).toBeNull();
    expect((await t.request('GET', `/images/${banner}`)).statusCode).toBe(404);
  });

  it('shows the chosen status to others, and hides whoever is invisible', async () => {
    const guild = await t.createGuild(owner);
    await t.join(guild, owner, member);
    const { client: ownerSocket } = await online(owner);

    await patch(member, { presence: 'dnd' });
    await ownerSocket.next('GUILD_SYNC', (data) => data.id === guild.id);
    const { ready } = await online(member);
    expect(ready.user.presence).toBe('dnd');
    await ownerSocket.next('PRESENCE_UPDATE', (data) => data.userId === member.user.id);
    const seen = await guildOf(owner, guild.id);
    expect(seen.onlineUserIds).toContain(member.user.id);
    expect(seen.members.find((entry) => entry.user.id === member.user.id)?.user.status).toBe('dnd');

    // Invisible: offline for the owner, online for the member, and nothing tells the two apart
    // from someone who is simply away from the app.
    await patch(member, { presence: 'invisible' });
    const hidden = await ownerSocket.next(
      'GUILD_SYNC',
      (data) => data.id === guild.id && !data.onlineUserIds.includes(member.user.id),
    );
    expect(hidden.members.find((entry) => entry.user.id === member.user.id)?.user.status).toBe(
      'online',
    );
    expect((await guildOf(member, guild.id)).onlineUserIds).toContain(member.user.id);

    // Connecting again while invisible announces nothing.
    const again = await connectGateway(t.wsUrl);
    clients.push(again);
    await again.identify(member.token);
    await ownerSocket.expectNone('PRESENCE_UPDATE', 300);
  });

  it('changes the password with the current one, and signs every session out', async () => {
    const account = await t.account('Trocadora');
    const change = (body: object, token = account.token) =>
      t.request('POST', '/users/@me/password', { token, body });

    expect(
      (await change({ currentPassword: 'errada', newPassword: 'nova senha bem longa' })).statusCode,
    ).toBe(401);
    expect(
      (await change({ currentPassword: account.password, newPassword: 'curta' })).statusCode,
    ).toBe(400);
    expect(
      (await change({ currentPassword: account.password, newPassword: 'nova senha bem longa' }))
        .statusCode,
    ).toBe(204);

    // The old session cannot be renewed, the old password is gone, the new one works.
    expect((await t.request('POST', '/auth/refresh', { cookie: account.cookie })).statusCode).toBe(
      401,
    );
    const login = (password: string) =>
      t.request('POST', '/auth/login', {
        body: { username: account.user.username, password },
      });
    expect((await login(account.password)).statusCode).toBe(401);
    const fresh = await login('nova senha bem longa');
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json<AuthResponse>().user.id).toBe(account.user.id);
  });
});
