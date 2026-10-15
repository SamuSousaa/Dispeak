import type { ApiErrorBody, Guild, SendFriendRequestResponse } from '@frequencia/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type Account, type TestApp } from './helpers/app';
import { connectGateway, type GatewayClient } from './helpers/gateway';

describe('private conversations with people who are not friends', () => {
  let t: TestApp;
  const clients: GatewayClient[] = [];

  const online = async (account: Account) => {
    const client = await connectGateway(t.wsUrl);
    clients.push(client);
    return { client, ready: await client.identify(account.token) };
  };
  const open = (from: Account, to: Account) =>
    t.request('POST', `/users/${to.user.id}/conversation`, { token: from.token });
  const textOf = (guild: Guild) => guild.channels.find((channel) => channel.type === 'text')?.id;
  const voiceOf = (guild: Guild) => guild.channels.find((channel) => channel.type === 'voice')?.id;
  const say = (from: Account, guild: Guild, content: string) =>
    t.request('POST', `/channels/${textOf(guild)}/messages`, {
      token: from.token,
      body: { content },
    });
  const guildAs = async (account: Account, guildId: string) =>
    (await t.request('GET', `/guilds/${guildId}`, { token: account.token })).json<Guild>();

  /** Two people in the same server who are not friends. */
  async function neighbours() {
    const [ana, beto] = await Promise.all([t.account('Ana'), t.account('Beto')]);
    const server = await t.createGuild(ana);
    await t.join(server, ana, beto);
    return { ana, beto };
  }

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  afterAll(async () => {
    await t.close();
  });

  it('needs a shared server, and respects a private profile', async () => {
    const [ana, stranger] = await Promise.all([t.account('Ana'), t.account('Estranho')]);
    const refused = await open(ana, stranger);
    expect(refused.statusCode).toBe(403);
    expect(refused.json<ApiErrorBody>().error).toBe('dm_closed');

    const beto = await t.account('Beto');
    await t.request('PATCH', '/users/@me/settings', {
      token: beto.token,
      body: { privateProfile: true },
    });
    const server = await t.createGuild(ana);
    await t.join(server, ana, beto);
    const closed = await open(ana, beto);
    expect(closed.statusCode).toBe(403);
    expect(closed.json<ApiErrorBody>().error).toBe('dm_closed');
  });

  it('arrives as a request after the first message, and answering accepts it', async () => {
    const { ana, beto } = await neighbours();
    const { client } = await online(beto);

    const opened = await open(ana, beto);
    expect(opened.statusCode).toBe(200);
    const dm = opened.json<Guild>();
    expect(dm.dm).toEqual({ friend: false, request: 'outgoing', blocked: null });
    // Opening twice is the same conversation.
    expect((await open(ana, beto)).json<Guild>().id).toBe(dm.id);
    // Nothing shown to Beto before a message.
    const joined = await client.next('GUILD_CREATE', (guild) => guild.id === dm.id);
    expect(joined.dm?.request).toBe('hidden');

    expect((await say(ana, dm, 'oi, tudo bem?')).statusCode).toBe(201);
    const shown = await client.next('GUILD_SYNC', (guild) => guild.id === dm.id);
    expect(shown.dm?.request).toBe('incoming');

    // No calls before Beto accepts.
    const token = await t.request('POST', `/channels/${voiceOf(dm)}/voice-token`, {
      token: ana.token,
    });
    expect(token.statusCode).toBe(403);

    expect((await say(beto, dm, 'tudo!')).statusCode).toBe(201);
    const accepted = await client.next(
      'GUILD_SYNC',
      (guild) => guild.id === dm.id && guild.dm?.request === null,
    );
    expect(accepted.dm).toEqual({ friend: false, request: null, blocked: null });
    expect(
      (await t.request('POST', `/channels/${voiceOf(dm)}/voice-token`, { token: ana.token }))
        .statusCode,
    ).toBe(200);
  });

  it('a declined request disappears for its recipient, not for its sender', async () => {
    const { ana, beto } = await neighbours();
    const dm = (await open(ana, beto)).json<Guild>();
    await say(ana, dm, 'olá');

    const declined = await t.request('POST', `/conversations/${dm.id}/decline`, {
      token: beto.token,
    });
    expect(declined.statusCode).toBe(204);
    expect((await guildAs(beto, dm.id)).dm?.request).toBe('hidden');
    expect((await guildAs(ana, dm.id)).dm?.request).toBe('outgoing');
    // Only the recipient answers a request.
    expect(
      (await t.request('POST', `/conversations/${dm.id}/accept`, { token: ana.token })).statusCode,
    ).toBe(404);
    // Beto changes his mind by opening the conversation himself.
    expect((await open(beto, ana)).json<Guild>().dm?.request).toBeNull();
  });

  it('becoming friends turns a request into a plain conversation', async () => {
    const { ana, beto } = await neighbours();
    const dm = (await open(ana, beto)).json<Guild>();
    const sent = (
      await t.request('POST', '/friends/requests', {
        token: ana.token,
        body: { username: beto.user.username },
      })
    ).json<SendFriendRequestResponse>();
    const accepted = await t.request('POST', `/friends/requests/${sent.request?.id}/accept`, {
      token: beto.token,
    });
    expect(accepted.json<Guild>()).toMatchObject({
      id: dm.id,
      dm: { friend: true, request: null, blocked: null },
    });
  });

  it('blocking closes the conversation both ways and ends the friendship', async () => {
    const { ana, beto } = await neighbours();
    const dm = (await open(ana, beto)).json<Guild>();
    await say(beto, dm, 'oi');
    const { client, ready } = await online(ana);
    expect(ready.blockedUserIds).toEqual([]);

    expect(
      (await t.request('PUT', `/users/@me/blocks/${beto.user.id}`, { token: ana.token }))
        .statusCode,
    ).toBe(204);
    expect(await client.next('BLOCKS_UPDATE')).toEqual({ userIds: [beto.user.id] });
    expect((await guildAs(ana, dm.id)).dm?.blocked).toBe('you');
    expect((await guildAs(beto, dm.id)).dm?.blocked).toBe('other');
    expect((await say(beto, dm, 'ainda aí?')).statusCode).toBe(403);
    expect((await say(ana, dm, 'não')).statusCode).toBe(403);
    const friendRequest = await t.request('POST', '/friends/requests', {
      token: beto.token,
      body: { username: ana.user.username },
    });
    expect(friendRequest.json<ApiErrorBody>().error).toBe('blocked');
    const blocks = await t.request('GET', '/users/@me/blocks', { token: ana.token });
    expect(blocks.json<{ users: Array<{ id: string }> }>().users.map((user) => user.id)).toEqual([
      beto.user.id,
    ]);

    await t.request('DELETE', `/users/@me/blocks/${beto.user.id}`, { token: ana.token });
    expect(await client.next('BLOCKS_UPDATE')).toEqual({ userIds: [] });
    expect((await say(beto, dm, 'e agora?')).statusCode).toBe(201);
  });
});
