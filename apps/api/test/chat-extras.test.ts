import {
  Permissions as P,
  REACTION_MAX_PER_MESSAGE,
  type Message,
  type MessagePage,
  type UnreadChannel,
} from '@frequencia/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type Account, type TestApp } from './helpers/app';
import { connectGateway, type GatewayClient } from './helpers/gateway';

describe('reactions, replies and unread messages', () => {
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
    if (!text) throw new Error('default text channel missing');
    return { guild, channelId: text.id };
  }
  const send = async (account: Account, channelId: string, body: object) => {
    const response = await t.request('POST', `/channels/${channelId}/messages`, {
      token: account.token,
      body,
    });
    expect(response.statusCode).toBe(201);
    return response.json<Message>();
  };
  const react = (
    account: Account,
    messageId: string,
    emoji: string,
    method: 'PUT' | 'DELETE' = 'PUT',
  ) =>
    t.request(method, `/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, {
      token: account.token,
    });
  const unread = async (account: Account) =>
    (await t.request('GET', '/users/@me/unread', { token: account.token })).json<{
      channels: UnreadChannel[];
    }>().channels;

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

  describe('reactions', () => {
    it('collects who reacted with what, live, and lets each user take theirs back', async () => {
      const { channelId } = await scenario();
      const message = await send(owner, channelId, { content: 'pizza hoje?' });
      expect(message.reactions).toEqual([]);
      const socket = await online(owner);

      const first = await react(member, message.id, '🍕');
      expect(first.statusCode).toBe(200);
      expect(first.json<Message>().reactions).toEqual([{ emoji: '🍕', userIds: [member.user.id] }]);
      expect((await socket.next('MESSAGE_UPDATE')).reactions).toEqual([
        { emoji: '🍕', userIds: [member.user.id] },
      ]);

      await react(owner, message.id, '🍕');
      await react(owner, message.id, '👍🏽');
      // Reacting twice with the same emoji changes nothing.
      await react(owner, message.id, '🍕');

      const page = (
        await t.request('GET', `/channels/${channelId}/messages`, { token: member.token })
      ).json<MessagePage>();
      expect(page.messages[0]?.reactions).toEqual([
        { emoji: '🍕', userIds: [member.user.id, owner.user.id] },
        { emoji: '👍🏽', userIds: [owner.user.id] },
      ]);

      const removed = await react(member, message.id, '🍕', 'DELETE');
      expect(removed.json<Message>().reactions).toEqual([
        { emoji: '🍕', userIds: [owner.user.id] },
        { emoji: '👍🏽', userIds: [owner.user.id] },
      ]);
    });

    it('only accepts emojis, and only from people who can see the channel', async () => {
      const { guild, channelId } = await scenario();
      const message = await send(owner, channelId, { content: 'oi' });

      expect((await react(member, message.id, 'kkk')).statusCode).toBe(400);
      expect((await react(member, message.id, '123')).statusCode).toBe(400);
      expect((await react(member, message.id, '<b>')).statusCode).toBe(400);
      expect((await react(outsider, message.id, '👍')).statusCode).toBe(404);

      // Hide the channel from everyone but the owner: it stops existing for the member.
      await t.request('PUT', `/channels/${channelId}/overwrites/${guild.id}`, {
        token: owner.token,
        body: { targetType: 'role', allow: '0', deny: P.ViewChannel.toString() },
      });
      expect((await react(member, message.id, '👍')).statusCode).toBe(404);
    });

    it('limits how many different emojis one message collects', async () => {
      const { channelId } = await scenario();
      const message = await send(owner, channelId, { content: 'oi' });
      const emojis = [...'😀😁😂🤣😃😄😅😆😉😊😋😎😍😘🥰😗😙😚🙂🤗🤩'];
      expect(emojis.length).toBe(REACTION_MAX_PER_MESSAGE + 1);

      for (const emoji of emojis.slice(0, REACTION_MAX_PER_MESSAGE)) {
        expect((await react(owner, message.id, emoji)).statusCode).toBe(200);
      }
      expect((await react(member, message.id, emojis.at(-1) ?? '')).statusCode).toBe(400);
      // Joining an emoji that is already there is still fine.
      expect((await react(member, message.id, emojis[0] ?? '')).statusCode).toBe(200);
    });
  });

  describe('replies', () => {
    it('carries the original along and mentions its author', async () => {
      const { channelId } = await scenario();
      const original = await send(owner, channelId, { content: 'quem joga hoje?' });
      const reply = await send(member, channelId, { content: 'eu!', replyToId: original.id });

      expect(reply.replyTo).toEqual({
        id: original.id,
        author: owner.user,
        content: 'quem joga hoje?',
        attachments: 0,
      });
      expect(reply.mentions).toEqual([owner.user.id]);

      // Editing the reply keeps the mention that came from answering.
      const edited = await t.request('PATCH', `/messages/${reply.id}`, {
        token: member.token,
        body: { content: 'eu também!' },
      });
      expect(edited.json<Message>().mentions).toEqual([owner.user.id]);
      expect(edited.json<Message>().replyTo?.id).toBe(original.id);
    });

    it('loses the quote, not the reply, when the original is deleted', async () => {
      const { channelId } = await scenario();
      const original = await send(owner, channelId, { content: 'apaga isso' });
      const reply = await send(member, channelId, { content: 'ok', replyToId: original.id });
      await t.request('DELETE', `/messages/${original.id}`, { token: owner.token });

      const page = (
        await t.request('GET', `/channels/${channelId}/messages`, { token: member.token })
      ).json<MessagePage>();
      expect(page.messages).toHaveLength(1);
      expect(page.messages[0]).toMatchObject({ id: reply.id, replyTo: null });
    });

    it('refuses to answer a message of another channel', async () => {
      const first = await scenario();
      const second = await scenario();
      const elsewhere = await send(owner, second.channelId, { content: 'outro lugar' });
      const response = await t.request('POST', `/channels/${first.channelId}/messages`, {
        token: member.token,
        body: { content: 'oi', replyToId: elsewhere.id },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('unread', () => {
    it('counts what others wrote since the last read mark, with mentions apart', async () => {
      const { guild, channelId } = await scenario();
      // The accounts are shared with the other tests: look at this guild only.
      const unreadHere = async (account: Account) =>
        (await unread(account)).filter((entry) => entry.guildId === guild.id);
      expect(await unreadHere(member)).toEqual([]);

      await send(owner, channelId, { content: 'primeira' });
      await send(owner, channelId, { content: `ei <@${member.user.id}>` });
      await send(member, channelId, { content: 'minha não conta' });

      expect(await unreadHere(member)).toEqual([
        { channelId, guildId: guild.id, count: 2, mentions: 1 },
      ]);
      // The owner only has the member's message to read.
      expect(await unreadHere(owner)).toEqual([
        { channelId, guildId: guild.id, count: 1, mentions: 0 },
      ]);

      const ack = await t.request('POST', `/channels/${channelId}/ack`, { token: member.token });
      expect(ack.statusCode).toBe(204);
      expect(await unreadHere(member)).toEqual([]);

      await send(owner, channelId, { content: 'depois do visto' });
      expect(await unreadHere(member)).toEqual([
        { channelId, guildId: guild.id, count: 1, mentions: 0 },
      ]);
    });

    it('ignores what was written before the user joined', async () => {
      const guild = await t.createGuild(owner);
      const channelId = guild.channels.find((channel) => channel.type === 'text')?.id ?? '';
      await send(owner, channelId, { content: 'antes de você chegar' });
      await t.join(guild, owner, member);
      expect((await unread(member)).filter((entry) => entry.guildId === guild.id)).toEqual([]);
    });

    it('hides channels the user can no longer see', async () => {
      const { guild, channelId } = await scenario();
      await send(owner, channelId, { content: 'segredo' });
      expect((await unread(member)).some((entry) => entry.channelId === channelId)).toBe(true);

      await t.request('PUT', `/channels/${channelId}/overwrites/${guild.id}`, {
        token: owner.token,
        body: { targetType: 'role', allow: '0', deny: P.ViewChannel.toString() },
      });
      expect((await unread(member)).some((entry) => entry.channelId === channelId)).toBe(false);
      const ack = await t.request('POST', `/channels/${channelId}/ack`, { token: member.token });
      expect(ack.statusCode).toBe(404);
    });
  });
});
