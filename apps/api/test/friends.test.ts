import type {
  FriendRequestsResponse,
  Guild,
  GuildSummary,
  Message,
  SendFriendRequestResponse,
} from '@frequencia/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type Account, type TestApp } from './helpers/app';
import { connectGateway, type GatewayClient } from './helpers/gateway';

describe('friends and private conversations', () => {
  let t: TestApp;
  const clients: GatewayClient[] = [];

  const online = async (account: Account) => {
    const client = await connectGateway(t.wsUrl);
    clients.push(client);
    const ready = await client.identify(account.token);
    return { client, ready };
  };
  const ask = (from: Account, username: string) =>
    t.request('POST', '/friends/requests', { token: from.token, body: { username } });
  const requestsOf = async (account: Account) =>
    (
      await t.request('GET', '/friends/requests', { token: account.token })
    ).json<FriendRequestsResponse>().requests;

  /** Two accounts that are already friends, and their conversation as the second one sees it. */
  async function friends() {
    const [ana, beto] = await Promise.all([t.account('Ana'), t.account('Beto')]);
    const sent = (await ask(ana, beto.user.username)).json<SendFriendRequestResponse>();
    const accepted = await t.request('POST', `/friends/requests/${sent.request?.id}/accept`, {
      token: beto.token,
    });
    expect(accepted.statusCode).toBe(200);
    return { ana, beto, dm: accepted.json<Guild>() };
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

  it('a request reaches the other person and shows up for both until answered', async () => {
    const [ana, beto] = await Promise.all([t.account('Ana'), t.account('Beto')]);
    const { client } = await online(beto);

    const response = await ask(ana, beto.user.username);
    expect(response.statusCode).toBe(200);
    const sent = response.json<SendFriendRequestResponse>();
    expect(sent.guild).toBeNull();
    expect(sent.request).toMatchObject({ direction: 'outgoing', user: { id: beto.user.id } });

    const event = await client.next('FRIEND_REQUEST_CREATE');
    expect(event).toMatchObject({ direction: 'incoming', user: { id: ana.user.id } });
    expect(await requestsOf(beto)).toMatchObject([{ id: sent.request?.id, direction: 'incoming' }]);
    expect(await requestsOf(ana)).toMatchObject([{ id: sent.request?.id, direction: 'outgoing' }]);

    // Asking twice, asking oneself and asking nobody are refused.
    expect((await ask(ana, beto.user.username)).statusCode).toBe(409);
    expect((await ask(ana, ana.user.username)).statusCode).toBe(400);
    expect((await ask(ana, 'ninguem.aqui')).statusCode).toBe(404);
  });

  it('accepting opens a conversation: two members, a text and a voice channel, no owner', async () => {
    const [ana, beto] = await Promise.all([t.account('Ana'), t.account('Beto')]);
    const anaSocket = await online(ana);
    const sent = (await ask(ana, beto.user.username)).json<SendFriendRequestResponse>();

    // Only the person who was asked can accept.
    const own = await t.request('POST', `/friends/requests/${sent.request?.id}/accept`, {
      token: ana.token,
    });
    expect(own.statusCode).toBe(404);

    const accepted = await t.request('POST', `/friends/requests/${sent.request?.id}/accept`, {
      token: beto.token,
    });
    const dm = accepted.json<Guild>();
    expect(dm.kind).toBe('dm');
    expect(dm.members.map((member) => member.user.id).sort()).toEqual(
      [ana.user.id, beto.user.id].sort(),
    );
    expect(dm.channels.map((channel) => channel.type)).toEqual(['text', 'voice']);

    const created = await anaSocket.client.next('GUILD_CREATE');
    expect(created).toMatchObject({ id: dm.id, kind: 'dm' });
    expect(await requestsOf(ana)).toEqual([]);
    expect((await ask(beto, ana.user.username)).statusCode).toBe(409);

    // It comes with READY, and is not one of the servers.
    const { ready } = await online(beto);
    expect(ready.guilds.map((guild) => guild.id)).toContain(dm.id);
    const servers = (await t.request('GET', '/guilds', { token: beto.token })).json<
      GuildSummary[]
    >();
    expect(servers.map((guild) => guild.id)).not.toContain(dm.id);
  });

  it('two people asking each other become friends at once', async () => {
    const [ana, beto] = await Promise.all([t.account('Ana'), t.account('Beto')]);
    await ask(ana, beto.user.username);
    const crossed = (await ask(beto, ana.user.username)).json<SendFriendRequestResponse>();
    expect(crossed.request).toBeNull();
    expect(crossed.guild).toMatchObject({ kind: 'dm' });
    expect(await requestsOf(ana)).toEqual([]);
  });

  it('messages flow in the conversation, and nobody else can reach it', async () => {
    const { ana, beto, dm } = await friends();
    const outsider = await t.account('Estranho');
    const text = dm.channels.find((channel) => channel.type === 'text');
    const { client } = await online(ana);

    const posted = await t.request('POST', `/channels/${text?.id}/messages`, {
      token: beto.token,
      body: { content: 'oi, só nós dois' },
    });
    expect(posted.statusCode).toBe(201);
    expect((await client.next('MESSAGE_CREATE')).content).toBe('oi, só nós dois');

    const peek = await t.request('GET', `/channels/${text?.id}/messages`, {
      token: outsider.token,
    });
    expect(peek.statusCode).toBe(404);
    const history = await t.request('GET', `/channels/${text?.id}/messages`, { token: ana.token });
    expect(history.json<{ messages: Message[] }>().messages).toHaveLength(1);
  });

  it('a conversation cannot be managed like a server', async () => {
    const { ana, beto, dm } = await friends();
    // Ana asked for the friendship; that makes her the owner of nothing.
    for (const account of [ana, beto]) {
      const attempts = await Promise.all([
        t.request('PATCH', `/guilds/${dm.id}`, { token: account.token, body: { name: 'meu' } }),
        t.request('DELETE', `/guilds/${dm.id}`, { token: account.token }),
        t.request('POST', `/guilds/${dm.id}/invites`, { token: account.token, body: {} }),
        t.request('POST', `/guilds/${dm.id}/channels`, {
          token: account.token,
          body: { type: 'text', name: 'outro' },
        }),
        t.request('DELETE', `/guilds/${dm.id}/members/@me`, { token: account.token }),
      ]);
      expect(attempts.map((response) => response.statusCode)).toEqual([403, 403, 403, 403, 403]);
    }
    const kick = await t.request('DELETE', `/guilds/${dm.id}/members/${beto.user.id}`, {
      token: ana.token,
    });
    expect(kick.statusCode).toBe(403);
  });

  it('declining or withdrawing removes the request for both', async () => {
    const [ana, beto] = await Promise.all([t.account('Ana'), t.account('Beto')]);
    const { client } = await online(ana);
    const sent = (await ask(ana, beto.user.username)).json<SendFriendRequestResponse>();
    await client.next('FRIEND_REQUEST_CREATE');

    const declined = await t.request('DELETE', `/friends/requests/${sent.request?.id}`, {
      token: beto.token,
    });
    expect(declined.statusCode).toBe(204);
    expect(await client.next('FRIEND_REQUEST_DELETE')).toEqual({ id: sent.request?.id });
    expect(await requestsOf(ana)).toEqual([]);

    // A stranger cannot remove a request between two other people.
    const again = (await ask(ana, beto.user.username)).json<SendFriendRequestResponse>();
    const outsider = await t.account('Estranho');
    const meddle = await t.request('DELETE', `/friends/requests/${again.request?.id}`, {
      token: outsider.token,
    });
    expect(meddle.statusCode).toBe(404);
  });

  it('ending the friendship deletes the conversation for both', async () => {
    const { ana, beto, dm } = await friends();
    const { client } = await online(beto);

    const removed = await t.request('DELETE', `/friends/${beto.user.id}`, { token: ana.token });
    expect(removed.statusCode).toBe(204);
    expect(await client.next('GUILD_DELETE')).toEqual({ id: dm.id });
    expect((await t.request('GET', `/guilds/${dm.id}`, { token: beto.token })).statusCode).toBe(
      404,
    );
    expect(
      (await t.request('DELETE', `/friends/${beto.user.id}`, { token: ana.token })).statusCode,
    ).toBe(404);
    // They can become friends again, starting from an empty conversation.
    expect((await ask(beto, ana.user.username)).statusCode).toBe(200);
  });
});
