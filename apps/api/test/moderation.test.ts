import {
  ApiErrorCode,
  Permissions as P,
  type Ban,
  type Guild,
  type Invite,
  type Member,
  type Message,
  type Role,
} from '@frequencia/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type Account, type TestApp } from './helpers/app';
import { connectGateway, type GatewayClient } from './helpers/gateway';

describe('moderation, role colours and chat in voice channels', () => {
  let t: TestApp;
  let owner: Account;
  let moderator: Account;
  let member: Account;
  let outsider: Account;
  const clients: GatewayClient[] = [];

  const online = async (account: Account) => {
    const client = await connectGateway(t.wsUrl);
    clients.push(client);
    await client.identify(account.token);
    return client;
  };

  /** Owner, a moderator holding `permissions`, and a plain member. */
  async function scenario(permissions: bigint = 0n) {
    const guild = await t.createGuild(owner);
    await t.join(guild, owner, moderator);
    await t.join(guild, owner, member);
    const role = await t.createRole(owner, guild.id, 'Moderação', permissions);
    await t.setRoles(owner, guild.id, moderator, [role.id]);
    return { guild, role };
  }
  const patchMember = (actor: Account, guildId: string, target: Account, body: object) =>
    t.request('PATCH', `/guilds/${guildId}/members/${target.user.id}`, {
      token: actor.token,
      body,
    });
  const guildOf = async (account: Account, guildId: string) =>
    (await t.request('GET', `/guilds/${guildId}`, { token: account.token })).json<Guild>();

  beforeAll(async () => {
    t = await createTestApp();
    [owner, moderator, member, outsider] = await Promise.all([
      t.account('Dona'),
      t.account('Moderador'),
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

  describe('server mute', () => {
    it('is set by whoever holds MUTE_MEMBERS and announced to the guild', async () => {
      const { guild } = await scenario(P.MuteMembers);
      const socket = await online(member);

      const response = await patchMember(moderator, guild.id, member, { serverMuted: true });
      expect(response.statusCode).toBe(200);
      expect(response.json<Member>().serverMuted).toBe(true);
      const update = await socket.next('MEMBER_UPDATE');
      expect(update.member).toMatchObject({ user: { id: member.user.id }, serverMuted: true });

      const lifted = await patchMember(owner, guild.id, member, { serverMuted: false });
      expect(lifted.json<Member>().serverMuted).toBe(false);
    });

    it('needs the permission and a higher rank', async () => {
      const { guild } = await scenario(P.MuteMembers);
      expect(
        (await patchMember(member, guild.id, moderator, { serverMuted: true })).statusCode,
      ).toBe(403);
      // Not even a moderator silences the owner.
      expect(
        (await patchMember(moderator, guild.id, owner, { serverMuted: true })).statusCode,
      ).toBe(403);
      expect(
        (await patchMember(outsider, guild.id, member, { serverMuted: true })).statusCode,
      ).toBe(404);
    });
  });

  describe('disconnecting from voice', () => {
    it('needs DISCONNECT_MEMBERS, and someone who is actually in a call', async () => {
      const { guild } = await scenario(P.DisconnectMembers);
      const path = `/guilds/${guild.id}/voice-states/${member.user.id}`;
      expect((await t.request('DELETE', path, { token: member.token })).statusCode).toBe(403);
      // Nobody is in voice in this test (there is no media service): nothing to disconnect.
      expect((await t.request('DELETE', path, { token: moderator.token })).statusCode).toBe(404);
      expect(
        (
          await t.request('DELETE', `/guilds/${guild.id}/voice-states/${owner.user.id}`, {
            token: moderator.token,
          })
        ).statusCode,
      ).toBe(403);
    });
  });

  describe('bans', () => {
    const ban = (
      actor: Account,
      guildId: string,
      target: Account,
      method = 'PUT' as 'PUT' | 'DELETE',
    ) => t.request(method, `/guilds/${guildId}/bans/${target.user.id}`, { token: actor.token });

    it('removes the member, refuses their invites and can be lifted', async () => {
      const { guild } = await scenario(P.BanMembers);
      const socket = await online(member);
      const invite = (
        await t.request('POST', `/guilds/${guild.id}/invites`, { token: owner.token, body: {} })
      ).json<Invite>();

      expect((await ban(moderator, guild.id, member)).statusCode).toBe(204);
      expect(await socket.next('GUILD_DELETE')).toEqual({ id: guild.id });
      expect((await guildOf(owner, guild.id)).members.map((entry) => entry.user.id)).not.toContain(
        member.user.id,
      );

      const refused = await t.request('POST', `/invites/${invite.code}/accept`, {
        token: member.token,
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json<{ error: string }>().error).toBe(ApiErrorCode.Banned);

      const bans = (
        await t.request('GET', `/guilds/${guild.id}/bans`, { token: owner.token })
      ).json<Ban[]>();
      expect(bans).toHaveLength(1);
      expect(bans[0]).toMatchObject({ user: member.user, bannedBy: moderator.user.id });

      expect((await ban(owner, guild.id, member, 'DELETE')).statusCode).toBe(204);
      expect(
        (await t.request('POST', `/invites/${invite.code}/accept`, { token: member.token }))
          .statusCode,
      ).toBe(200);
    });

    it('respects the permission and the hierarchy', async () => {
      const { guild } = await scenario(P.BanMembers);
      expect((await ban(member, guild.id, moderator)).statusCode).toBe(403);
      expect((await ban(moderator, guild.id, owner)).statusCode).toBe(403);
      expect((await ban(moderator, guild.id, moderator)).statusCode).toBe(400);
      expect(
        (await t.request('GET', `/guilds/${guild.id}/bans`, { token: member.token })).statusCode,
      ).toBe(403);
      // Someone who is not a member can be banned ahead of time.
      expect((await ban(owner, guild.id, outsider)).statusCode).toBe(204);
      expect((await ban(owner, guild.id, outsider, 'DELETE')).statusCode).toBe(204);
      expect((await ban(owner, guild.id, outsider, 'DELETE')).statusCode).toBe(404);
    });
  });

  describe('role colours', () => {
    it('are stored in lowercase, changed and removed', async () => {
      const guild = await t.createGuild(owner);
      const created = await t.request('POST', `/guilds/${guild.id}/roles`, {
        token: owner.token,
        body: { name: 'Vermelhos', color: '#FF0033' },
      });
      expect(created.statusCode).toBe(201);
      const role = created.json<Role>();
      expect(role.color).toBe('#ff0033');

      const patch = (body: object) =>
        t.request('PATCH', `/roles/${role.id}`, { token: owner.token, body });
      // Renaming leaves the colour alone.
      expect((await patch({ name: 'Rubros' })).json<Role>().color).toBe('#ff0033');
      expect((await patch({ color: '#00aaff' })).json<Role>().color).toBe('#00aaff');
      expect((await patch({ color: null })).json<Role>().color).toBeNull();
      expect((await patch({ color: 'red' })).statusCode).toBe(400);
      expect((await patch({ color: 'javascript:alert(1)' })).statusCode).toBe(400);
    });
  });

  describe('new chat permissions', () => {
    it('come with @everyone and can be taken away per channel', async () => {
      const { guild } = await scenario();
      const everyone = guild.roles.find((role) => role.id === guild.id);
      expect(BigInt(everyone?.permissions ?? '0') & P.AddReactions).toBe(P.AddReactions);
      expect(BigInt(everyone?.permissions ?? '0') & P.AttachFiles).toBe(P.AttachFiles);

      const channelId = guild.channels.find((channel) => channel.type === 'text')?.id ?? '';
      const sent = (
        await t.request('POST', `/channels/${channelId}/messages`, {
          token: owner.token,
          body: { content: 'reaja' },
        })
      ).json<Message>();
      const react = () =>
        t.request('PUT', `/messages/${sent.id}/reactions/${encodeURIComponent('👍')}`, {
          token: member.token,
        });
      expect((await react()).statusCode).toBe(200);

      await t.request('PUT', `/channels/${channelId}/overwrites/${guild.id}`, {
        token: owner.token,
        body: {
          targetType: 'role',
          allow: '0',
          deny: (P.AddReactions | P.AttachFiles).toString(),
        },
      });
      await t.request('DELETE', `/messages/${sent.id}/reactions/${encodeURIComponent('👍')}`, {
        token: member.token,
      });
      expect((await react()).statusCode).toBe(403);
      const upload = await t.app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/attachments?filename=x.png`,
        headers: { 'content-type': 'image/png', authorization: `Bearer ${member.token}` },
        payload: Buffer.from('not checked: the permission comes first'),
      });
      expect(upload.statusCode).toBe(403);
    });
  });

  describe('chat in voice channels', () => {
    it('works like a text channel, under the voice channel permissions', async () => {
      const { guild } = await scenario();
      const voiceId = guild.channels.find((channel) => channel.type === 'voice')?.id ?? '';
      const categoryId = guild.channels.find((channel) => channel.type === 'category')?.id ?? '';
      const socket = await online(owner);

      const sent = await t.request('POST', `/channels/${voiceId}/messages`, {
        token: member.token,
        body: { content: 'alguém aí na call?' },
      });
      expect(sent.statusCode).toBe(201);
      expect((await socket.next('MESSAGE_CREATE')).channelId).toBe(voiceId);
      expect(
        (await t.request('GET', `/channels/${voiceId}/messages`, { token: owner.token })).json<{
          messages: Message[];
        }>().messages,
      ).toHaveLength(1);

      // Categories still hold no messages, and outsiders see nothing.
      expect(
        (
          await t.request('POST', `/channels/${categoryId}/messages`, {
            token: member.token,
            body: { content: 'x' },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (await t.request('GET', `/channels/${voiceId}/messages`, { token: outsider.token }))
          .statusCode,
      ).toBe(404);
    });
  });
});
