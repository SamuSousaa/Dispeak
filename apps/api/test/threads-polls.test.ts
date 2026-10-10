import {
  Permissions as P,
  type Channel,
  type Guild,
  type Message,
  type MessagePage,
  type UnreadChannel,
} from '@frequencia/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type Account, type TestApp } from './helpers/app';
import { connectGateway, type GatewayClient } from './helpers/gateway';

describe('threads and polls', () => {
  let t: TestApp;
  let owner: Account;
  let member: Account;
  let outsider: Account;
  const clients: GatewayClient[] = [];

  const online = async (account: Account) => {
    const client = await connectGateway(t.wsUrl);
    clients.push(client);
    await client.identify(account.token);
    return client;
  };
  async function scenario() {
    const guild = await t.createGuild(owner);
    await t.join(guild, owner, member);
    const text = guild.channels.find((channel) => channel.type === 'text');
    const voice = guild.channels.find((channel) => channel.type === 'voice');
    if (!text || !voice) throw new Error('default channels missing');
    return { guild, channelId: text.id, voiceId: voice.id };
  }
  const openThread = (account: Account, channelId: string, name = 'churrasco de sábado') =>
    t.request('POST', `/channels/${channelId}/threads`, { token: account.token, body: { name } });
  const send = (account: Account, channelId: string, body: object) =>
    t.request('POST', `/channels/${channelId}/messages`, { token: account.token, body });
  const guildOf = async (account: Account, guildId: string) =>
    (await t.request('GET', `/guilds/${guildId}`, { token: account.token })).json<Guild>();

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

  describe('threads', () => {
    it('are opened by anyone who can write in the channel, and hold their own messages', async () => {
      const { guild, channelId } = await scenario();
      const socket = await online(owner);

      const response = await openThread(member, channelId);
      expect(response.statusCode).toBe(201);
      const thread = response.json<Channel>();
      expect(thread).toMatchObject({
        type: 'thread',
        name: 'churrasco de sábado',
        parentId: channelId,
        guildId: guild.id,
      });
      expect(await socket.next('CHANNEL_CREATE')).toEqual(thread);

      expect((await send(owner, thread.id, { content: 'quem leva a carne?' })).statusCode).toBe(
        201,
      );
      const page = (
        await t.request('GET', `/channels/${thread.id}/messages`, { token: member.token })
      ).json<MessagePage>();
      expect(page.messages.map((message) => message.content)).toEqual(['quem leva a carne?']);
      // The channel itself did not get the message.
      expect(
        (
          await t.request('GET', `/channels/${channelId}/messages`, { token: member.token })
        ).json<MessagePage>().messages,
      ).toEqual([]);

      // Unread messages are counted per thread.
      const unread = (await t.request('GET', '/users/@me/unread', { token: member.token })).json<{
        channels: UnreadChannel[];
      }>().channels;
      expect(unread.find((entry) => entry.channelId === thread.id)).toMatchObject({ count: 1 });
    });

    it('follow the permissions of their channel', async () => {
      const { guild, channelId, voiceId } = await scenario();
      const thread = (await openThread(owner, channelId)).json<Channel>();

      expect((await openThread(outsider, channelId)).statusCode).toBe(404);
      expect((await openThread(member, voiceId)).statusCode).toBe(400);
      expect((await openThread(member, thread.id)).statusCode).toBe(400);

      // Read-only channel: no new threads, and no writing in the existing one.
      await t.request('PUT', `/channels/${channelId}/overwrites/${guild.id}`, {
        token: owner.token,
        body: { targetType: 'role', allow: '0', deny: P.SendMessages.toString() },
      });
      expect((await openThread(member, channelId)).statusCode).toBe(403);
      expect((await send(member, thread.id, { content: 'oi' })).statusCode).toBe(403);

      // Hidden channel: the thread stops existing for the member as well.
      await t.request('PUT', `/channels/${channelId}/overwrites/${guild.id}`, {
        token: owner.token,
        body: { targetType: 'role', allow: '0', deny: P.ViewChannel.toString() },
      });
      expect((await guildOf(member, guild.id)).channels.map((channel) => channel.id)).not.toContain(
        thread.id,
      );
      expect(
        (await t.request('GET', `/channels/${thread.id}/messages`, { token: member.token }))
          .statusCode,
      ).toBe(404);
    });

    it('are renamed and deleted by whoever manages channels, and go with their channel', async () => {
      const { guild, channelId } = await scenario();
      const first = (await openThread(member, channelId, 'um')).json<Channel>();
      const second = (await openThread(member, channelId, 'dois')).json<Channel>();

      // Opening a thread does not make its author a channel manager.
      expect(
        (await t.request('DELETE', `/channels/${first.id}`, { token: member.token })).statusCode,
      ).toBe(403);
      const renamed = await t.request('PATCH', `/channels/${first.id}`, {
        token: owner.token,
        body: { name: 'renomeado' },
      });
      expect(renamed.json<Channel>()).toMatchObject({ name: 'renomeado', type: 'thread' });
      // A thread cannot be moved elsewhere, nor created through the channel endpoint.
      expect(
        (
          await t.request('PATCH', `/channels/${first.id}`, {
            token: owner.token,
            body: { parentId: null },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await t.request('POST', `/guilds/${guild.id}/channels`, {
            token: owner.token,
            body: { name: 'x', type: 'thread' },
          })
        ).statusCode,
      ).toBe(400);

      const socket = await online(member);
      expect(
        (await t.request('DELETE', `/channels/${channelId}`, { token: owner.token })).statusCode,
      ).toBe(204);
      const gone = [
        await socket.next('CHANNEL_DELETE'),
        await socket.next('CHANNEL_DELETE'),
        await socket.next('CHANNEL_DELETE'),
      ].map((event) => event.id);
      expect(gone.sort()).toEqual([channelId, first.id, second.id].sort());
      expect((await guildOf(owner, guild.id)).channels.map((channel) => channel.id)).not.toContain(
        second.id,
      );
    });
  });

  describe('polls', () => {
    const vote = (account: Account, messageId: string, optionIds: string[]) =>
      t.request('PUT', `/messages/${messageId}/poll/votes`, {
        token: account.token,
        body: { optionIds },
      });

    it('travel in a message and count one answer per person', async () => {
      const { channelId } = await scenario();
      const created = await send(owner, channelId, {
        poll: { question: 'Que horas?', options: ['20h', '21h', '22h'] },
      });
      expect(created.statusCode).toBe(201);
      const message = created.json<Message>();
      expect(message.content).toBe('');
      expect(message.poll).toMatchObject({ question: 'Que horas?', multiple: false });
      const [eight, nine] = message.poll?.options ?? [];
      expect(message.poll?.options.map((option) => option.text)).toEqual(['20h', '21h', '22h']);

      const socket = await online(owner);
      const first = await vote(member, message.id, [eight?.id ?? '']);
      expect(first.statusCode).toBe(200);
      expect((await socket.next('MESSAGE_UPDATE')).poll?.options[0]?.voterIds).toEqual([
        member.user.id,
      ]);

      // Changing one's mind moves the vote; an empty list takes it back.
      await vote(member, message.id, [nine?.id ?? '']);
      await vote(owner, message.id, [nine?.id ?? '']);
      const page = (
        await t.request('GET', `/channels/${channelId}/messages`, { token: member.token })
      ).json<MessagePage>();
      expect(page.messages[0]?.poll?.options.map((option) => option.voterIds)).toEqual([
        [],
        [member.user.id, owner.user.id],
        [],
      ]);
      const cleared = await vote(member, message.id, []);
      expect(cleared.json<Message>().poll?.options[1]?.voterIds).toEqual([owner.user.id]);
    });

    it('refuses more than one answer unless the poll allows it', async () => {
      const { channelId } = await scenario();
      const single = (
        await send(owner, channelId, { poll: { question: 'Um só', options: ['a', 'b'] } })
      ).json<Message>();
      const ids = single.poll?.options.map((option) => option.id) ?? [];
      expect((await vote(member, single.id, ids)).statusCode).toBe(400);

      const many = (
        await send(owner, channelId, {
          poll: { question: 'Vários', options: ['a', 'b', 'c'], multiple: true },
        })
      ).json<Message>();
      const all = many.poll?.options.map((option) => option.id) ?? [];
      const voted = await vote(member, many.id, all.slice(0, 2));
      expect(voted.json<Message>().poll?.options.map((option) => option.voterIds.length)).toEqual([
        1, 1, 0,
      ]);
      // An option of another poll is not an option of this one.
      expect((await vote(member, many.id, [ids[0] ?? ''])).statusCode).toBe(400);
    });

    it('validates the poll and who may vote', async () => {
      const { channelId } = await scenario();
      for (const poll of [
        { question: '', options: ['a', 'b'] },
        { question: 'x', options: ['só uma'] },
        { question: 'x', options: Array.from({ length: 11 }, (_, index) => `opção ${index}`) },
      ]) {
        expect((await send(owner, channelId, { poll })).statusCode).toBe(400);
      }
      const plain = (await send(owner, channelId, { content: 'sem enquete' })).json<Message>();
      expect(plain.poll).toBeNull();
      expect((await vote(member, plain.id, [])).statusCode).toBe(404);

      const message = (
        await send(owner, channelId, { poll: { question: 'x', options: ['a', 'b'] } })
      ).json<Message>();
      expect((await vote(outsider, message.id, [])).statusCode).toBe(404);
    });
  });
});
