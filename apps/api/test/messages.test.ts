import {
  DEFAULT_EVERYONE_PERMISSIONS,
  formatMention,
  Permissions as P,
  type Guild,
  type Message,
  type MessagePage,
} from '@frequencia/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type Account, type TestApp } from './helpers/app';
import { connectGateway, type GatewayClient } from './helpers/gateway';

describe('messages', () => {
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

  /** A guild with owner and member, plus the id of its default text channel. */
  async function scenario() {
    const guild = await t.createGuild(owner);
    await t.join(guild, owner, member);
    const text = guild.channels.find((channel) => channel.type === 'text');
    if (!text) throw new Error('default text channel missing');
    return { guild, channelId: text.id };
  }
  const send = (account: Account, channelId: string, content: string) =>
    t.request('POST', `/channels/${channelId}/messages`, {
      token: account.token,
      body: { content },
    });
  const list = async (account: Account, channelId: string, query = '') =>
    (
      await t.request('GET', `/channels/${channelId}/messages${query}`, { token: account.token })
    ).json<MessagePage>();

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

  describe('sending', () => {
    it('stores the message and delivers it to the channel in real time', async () => {
      const { guild, channelId } = await scenario();
      const socket = await online(owner);

      const response = await send(member, channelId, '  olá, pessoal  ');
      expect(response.statusCode).toBe(201);
      const message = response.json<Message>();
      expect(message).toMatchObject({
        channelId,
        guildId: guild.id,
        author: member.user,
        content: 'olá, pessoal',
        mentions: [],
        mentionEveryone: false,
        editedAt: null,
      });
      expect(await socket.next('MESSAGE_CREATE')).toEqual(message);
      expect((await list(owner, channelId)).messages).toEqual([message]);
    });

    it('validates the content', async () => {
      const { channelId } = await scenario();
      for (const content of ['', '   ', 'x'.repeat(2001)]) {
        expect((await send(member, channelId, content)).statusCode).toBe(400);
      }
      expect((await send(member, channelId, 'x'.repeat(2000))).statusCode).toBe(201);
    });

    it('requires membership, visibility, SEND_MESSAGES and a text channel', async () => {
      const { guild, channelId } = await scenario();
      const voice = guild.channels.find((channel) => channel.type === 'voice');

      expect((await send(outsider, channelId, 'oi')).statusCode).toBe(404);
      expect((await send(member, voice?.id ?? '', 'oi')).statusCode).toBe(404);

      // Read-only channel: members can still read but not write.
      await t.request('PUT', `/channels/${channelId}/overwrites/${guild.id}`, {
        token: owner.token,
        body: { targetType: 'role', allow: '0', deny: P.SendMessages.toString() },
      });
      expect((await send(member, channelId, 'oi')).statusCode).toBe(403);
      expect((await send(owner, channelId, 'aviso')).statusCode).toBe(201);
      expect((await list(member, channelId)).messages).toHaveLength(1);

      // Hidden channel: it does not exist as far as the member is concerned.
      await t.request('PUT', `/channels/${channelId}/overwrites/${guild.id}`, {
        token: owner.token,
        body: { targetType: 'role', allow: '0', deny: P.ViewChannel.toString() },
      });
      expect((await send(member, channelId, 'oi')).statusCode).toBe(404);
      const hidden = await t.request('GET', `/channels/${channelId}/messages`, {
        token: member.token,
      });
      expect(hidden.statusCode).toBe(404);
    });

    it('does not deliver messages to members who cannot see the channel', async () => {
      const { guild, channelId } = await scenario();
      await t.request('PUT', `/channels/${channelId}/overwrites/${member.user.id}`, {
        token: owner.token,
        body: { targetType: 'member', allow: '0', deny: P.ViewChannel.toString() },
      });
      const memberSocket = await online(member);
      const ownerSocket = await online(owner);

      await send(owner, channelId, 'segredo');
      await ownerSocket.next('MESSAGE_CREATE');
      await memberSocket.expectNone('MESSAGE_CREATE');
      expect(guild.id).toBeTruthy();
    });
  });

  describe('mentions', () => {
    it('records mentioned members and ignores unknown or outside users', async () => {
      const { channelId } = await scenario();
      const content = [
        `oi ${formatMention(owner.user.id)}`,
        formatMention(owner.user.id), // repeated
        formatMention(outsider.user.id), // not a member
        formatMention('00000000-0000-4000-8000-000000000000'), // nobody
      ].join(' ');

      const message = (await send(member, channelId, content)).json<Message>();
      expect(message.mentions).toEqual([owner.user.id]);
      expect(message.content).toBe(content);
    });

    it('does not record mentions of members who cannot see the channel', async () => {
      const { channelId } = await scenario();
      await t.request('PUT', `/channels/${channelId}/overwrites/${member.user.id}`, {
        token: owner.token,
        body: { targetType: 'member', allow: '0', deny: P.ViewChannel.toString() },
      });
      const message = (
        await send(owner, channelId, `psiu ${formatMention(member.user.id)}`)
      ).json<Message>();
      expect(message.mentions).toEqual([]);
    });

    it('honours @todos only with MENTION_EVERYONE', async () => {
      const { guild, channelId } = await scenario();
      expect(DEFAULT_EVERYONE_PERMISSIONS & P.MentionEveryone).toBe(0n);

      const denied = (await send(member, channelId, '@todos reunião')).json<Message>();
      expect(denied.mentionEveryone).toBe(false);
      const allowed = (await send(owner, channelId, '@todos reunião')).json<Message>();
      expect(allowed.mentionEveryone).toBe(true);

      const announcer = await t.createRole(owner, guild.id, 'Anunciante', P.MentionEveryone);
      await t.setRoles(owner, guild.id, member, [announcer.id]);
      expect((await send(member, channelId, '@todos agora posso')).json<Message>()).toMatchObject({
        mentionEveryone: true,
      });
    });
  });

  describe('editing and deleting', () => {
    it('lets the author edit, recomputing mentions and marking the edit', async () => {
      const { channelId } = await scenario();
      const socket = await online(owner);
      const original = (await send(member, channelId, 'primeira versão')).json<Message>();

      const response = await t.request('PATCH', `/messages/${original.id}`, {
        token: member.token,
        body: { content: `corrigido ${formatMention(owner.user.id)}` },
      });
      const edited = response.json<Message>();
      expect(edited).toMatchObject({
        id: original.id,
        content: `corrigido ${formatMention(owner.user.id)}`,
        mentions: [owner.user.id],
        createdAt: original.createdAt,
      });
      expect(Date.parse(edited.editedAt ?? '')).toBeGreaterThanOrEqual(
        Date.parse(original.createdAt),
      );
      expect(await socket.next('MESSAGE_UPDATE')).toEqual(edited);
    });

    it('does not let anyone else edit, not even the owner', async () => {
      const { channelId } = await scenario();
      const message = (await send(member, channelId, 'minha mensagem')).json<Message>();
      const response = await t.request('PATCH', `/messages/${message.id}`, {
        token: owner.token,
        body: { content: 'adulterada' },
      });
      expect(response.statusCode).toBe(403);
      expect((await list(owner, channelId)).messages[0]?.content).toBe('minha mensagem');
    });

    it('lets authors delete their own messages and moderators delete any', async () => {
      const { guild, channelId } = await scenario();
      const other = await t.account();
      await t.join(guild as Guild, owner, other);
      const socket = await online(owner);
      const mine = (await send(member, channelId, 'apago eu')).json<Message>();
      const theirs = (await send(other, channelId, 'apaga o mod')).json<Message>();
      const remove = (account: Account, id: string) =>
        t.request('DELETE', `/messages/${id}`, { token: account.token });

      expect((await remove(member, theirs.id)).statusCode).toBe(403);
      expect((await remove(member, mine.id)).statusCode).toBe(204);
      expect(await socket.next('MESSAGE_DELETE')).toEqual({
        id: mine.id,
        channelId,
        guildId: guild.id,
      });

      const moderator = await t.createRole(owner, guild.id, 'Moderador', P.ManageMessages);
      await t.setRoles(owner, guild.id, member, [moderator.id]);
      expect((await remove(member, theirs.id)).statusCode).toBe(204);
      expect((await list(owner, channelId)).messages).toEqual([]);
      expect((await remove(member, theirs.id)).statusCode).toBe(404);
    });

    it('hides messages of channels the user cannot see', async () => {
      const { channelId } = await scenario();
      const message = (await send(owner, channelId, 'privado')).json<Message>();
      const response = await t.request('DELETE', `/messages/${message.id}`, {
        token: outsider.token,
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('pagination', () => {
    it('walks the history backwards with a cursor, without gaps or repeats', async () => {
      const { channelId } = await scenario();
      for (let i = 1; i <= 25; i++) await send(owner, channelId, `mensagem ${i}`);

      const seen: string[] = [];
      let cursor: string | null | undefined;
      let pages = 0;
      do {
        const page: MessagePage = await list(
          member,
          channelId,
          `?limit=10${cursor ? `&before=${cursor}` : ''}`,
        );
        // Each page is chronological, and older than everything seen so far.
        seen.unshift(...page.messages.map((message) => message.content));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor);

      expect(pages).toBe(3);
      expect(seen).toEqual(Array.from({ length: 25 }, (_, index) => `mensagem ${index + 1}`));
    });

    it('returns the newest page by default and no cursor when everything fits', async () => {
      const { channelId } = await scenario();
      for (let i = 1; i <= 3; i++) await send(owner, channelId, `m${i}`);
      const page = await list(owner, channelId);
      expect(page.messages.map((message) => message.content)).toEqual(['m1', 'm2', 'm3']);
      expect(page.nextCursor).toBeNull();

      // An exact fit must not promise a page that does not exist.
      const exact = await list(owner, channelId, '?limit=3');
      expect(exact.nextCursor).toBeNull();
      const partial = await list(owner, channelId, '?limit=2');
      expect(partial.messages.map((message) => message.content)).toEqual(['m2', 'm3']);
      expect(partial.nextCursor).toBe(partial.messages[0]?.id);
    });

    it('validates the query', async () => {
      const { channelId } = await scenario();
      for (const query of ['?limit=0', '?limit=500', '?before=not-an-id']) {
        const response = await t.request('GET', `/channels/${channelId}/messages${query}`, {
          token: owner.token,
        });
        expect(response.statusCode).toBe(400);
      }
    });
  });

  describe('typing', () => {
    it('notifies the channel that someone is typing', async () => {
      const { guild, channelId } = await scenario();
      const socket = await online(owner);
      const response = await t.request('POST', `/channels/${channelId}/typing`, {
        token: member.token,
      });
      expect(response.statusCode).toBe(204);
      expect(await socket.next('TYPING_START')).toEqual({
        guildId: guild.id,
        channelId,
        userId: member.user.id,
      });
    });

    it('requires SEND_MESSAGES', async () => {
      const { guild, channelId } = await scenario();
      await t.request('PUT', `/channels/${channelId}/overwrites/${guild.id}`, {
        token: owner.token,
        body: { targetType: 'role', allow: '0', deny: P.SendMessages.toString() },
      });
      const response = await t.request('POST', `/channels/${channelId}/typing`, {
        token: member.token,
      });
      expect(response.statusCode).toBe(403);
    });
  });

  it('removes the history with the channel', async () => {
    const { channelId } = await scenario();
    const message = (await send(owner, channelId, 'vai sumir')).json<Message>();
    await t.request('DELETE', `/channels/${channelId}`, { token: owner.token });
    const response = await t.request('DELETE', `/messages/${message.id}`, { token: owner.token });
    expect(response.statusCode).toBe(404);
  });
});

describe('message rate limiting', () => {
  it('limits each user separately, even from the same address', async () => {
    const limited = await createTestApp({ RATE_LIMIT_MESSAGES_MAX: '3' });
    try {
      const [alice, bob] = await Promise.all([limited.account(), limited.account()]);
      const guild = await limited.createGuild(alice);
      await limited.join(guild, alice, bob);
      const channelId = guild.channels.find((channel) => channel.type === 'text')?.id;
      const send = (account: Account) =>
        limited.request('POST', `/channels/${channelId}/messages`, {
          token: account.token,
          body: { content: 'oi' },
          ip: '198.51.100.20',
        });

      const statuses = [];
      for (let i = 0; i < 5; i++) statuses.push((await send(alice)).statusCode);
      expect(statuses).toEqual([201, 201, 201, 429, 429]);
      // Bob shares the address but has his own budget.
      expect((await send(bob)).statusCode).toBe(201);
    } finally {
      await limited.close();
    }
  });
});
