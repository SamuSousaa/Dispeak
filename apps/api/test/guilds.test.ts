import {
  DEFAULT_EVERYONE_PERMISSIONS,
  Permissions as P,
  type Channel,
  type Guild,
  type Invite,
  type InvitePreview,
} from '@frequencia/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { createTestApp, type Account, type TestApp } from './helpers/app';

describe('guilds', () => {
  let t: TestApp;
  let owner: Account;
  let member: Account;
  let outsider: Account;

  beforeAll(async () => {
    t = await createTestApp();
    [owner, member, outsider] = await Promise.all([
      t.account('Dona'),
      t.account('Membro'),
      t.account('Estranho'),
    ]);
  });

  afterAll(async () => {
    await t.close();
  });

  const getGuild = async (account: Account, guildId: string) =>
    (await t.request('GET', `/guilds/${guildId}`, { token: account.token })).json<Guild>();

  describe('lifecycle', () => {
    it('creates a guild with @everyone, default channels and the owner as member', async () => {
      const guild = await t.createGuild(owner, 'Amigos');

      expect(guild).toMatchObject({ name: 'Amigos', ownerId: owner.user.id });
      expect(guild.roles).toEqual([
        {
          id: guild.id,
          guildId: guild.id,
          name: '@everyone',
          permissions: DEFAULT_EVERYONE_PERMISSIONS.toString(),
          position: 0,
          color: null,
        },
      ]);
      expect(guild.members.map((entry) => entry.user.id)).toEqual([owner.user.id]);
      expect(guild.channels.map((channel) => [channel.type, channel.name])).toEqual(
        expect.arrayContaining([
          ['category', 'Texto'],
          ['category', 'Voz'],
          ['text', 'geral'],
          ['voice', 'Geral'],
        ]),
      );
      const text = guild.channels.find((channel) => channel.type === 'text');
      const category = guild.channels.find((channel) => channel.name === 'Texto');
      expect(text?.parentId).toBe(category?.id);
    });

    it('lists only the guilds the user belongs to', async () => {
      const guild = await t.createGuild(owner);
      const mine = await t.request('GET', '/guilds', { token: owner.token });
      const theirs = await t.request('GET', '/guilds', { token: outsider.token });
      expect(mine.json<Guild[]>().map((entry) => entry.id)).toContain(guild.id);
      expect(theirs.json<Guild[]>().map((entry) => entry.id)).not.toContain(guild.id);
    });

    it('hides the existence of a guild from non-members', async () => {
      const guild = await t.createGuild(owner);
      const response = await t.request('GET', `/guilds/${guild.id}`, { token: outsider.token });
      expect(response.statusCode).toBe(404);
      const rename = await t.request('PATCH', `/guilds/${guild.id}`, {
        token: outsider.token,
        body: { name: 'Hackeado' },
      });
      expect(rename.statusCode).toBe(404);
    });

    it('requires MANAGE_GUILD to rename', async () => {
      const guild = await t.createGuild(owner);
      await t.join(guild, owner, member);

      const denied = await t.request('PATCH', `/guilds/${guild.id}`, {
        token: member.token,
        body: { name: 'Novo nome' },
      });
      expect(denied.statusCode).toBe(403);

      const manager = await t.createRole(owner, guild.id, 'Gerente', P.ManageGuild);
      await t.setRoles(owner, guild.id, member, [manager.id]);
      const allowed = await t.request('PATCH', `/guilds/${guild.id}`, {
        token: member.token,
        body: { name: 'Novo nome' },
      });
      expect(allowed.statusCode).toBe(200);
      expect((await getGuild(owner, guild.id)).name).toBe('Novo nome');
    });

    it('lets only the owner delete, and removes everything with it', async () => {
      const guild = await t.createGuild(owner);
      await t.join(guild, owner, member);
      const admin = await t.createRole(owner, guild.id, 'Admin', P.Administrator);
      await t.setRoles(owner, guild.id, member, [admin.id]);

      const denied = await t.request('DELETE', `/guilds/${guild.id}`, { token: member.token });
      expect(denied.statusCode).toBe(403);

      const deleted = await t.request('DELETE', `/guilds/${guild.id}`, { token: owner.token });
      expect(deleted.statusCode).toBe(204);
      expect(
        (await t.request('GET', `/guilds/${guild.id}`, { token: owner.token })).statusCode,
      ).toBe(404);
      const leftovers = await t.app.ctx.db
        .select()
        .from(schema.channels)
        .where(eq(schema.channels.guildId, guild.id));
      expect(leftovers).toEqual([]);
    });
  });

  describe('invites', () => {
    it('lets a friend preview and join with a code', async () => {
      const guild = await t.createGuild(owner, 'Clube');
      const created = await t.request('POST', `/guilds/${guild.id}/invites`, {
        token: owner.token,
        body: {},
      });
      expect(created.statusCode).toBe(201);
      const invite = created.json<Invite>();
      expect(invite).toMatchObject({ guildId: guild.id, maxUses: null, uses: 0, expiresAt: null });
      expect(invite.code).toMatch(/^[a-zA-Z0-9]{8}$/);

      const preview = await t.request('GET', `/invites/${invite.code}`, { token: member.token });
      expect(preview.json<InvitePreview>()).toEqual({
        code: invite.code,
        guild: { id: guild.id, name: 'Clube', memberCount: 1 },
        alreadyMember: false,
      });

      const accepted = await t.request('POST', `/invites/${invite.code}/accept`, {
        token: member.token,
      });
      expect(accepted.statusCode).toBe(200);
      expect(
        accepted
          .json<Guild>()
          .members.map((entry) => entry.user.id)
          .sort(),
      ).toEqual([owner.user.id, member.user.id].sort());
    });

    it('requires authentication even to preview', async () => {
      const response = await t.request('GET', '/invites/whatever');
      expect(response.statusCode).toBe(401);
    });

    it('does not consume a use when a member accepts again', async () => {
      const guild = await t.createGuild(owner);
      const invite = (
        await t.request('POST', `/guilds/${guild.id}/invites`, {
          token: owner.token,
          body: { maxUses: 1 },
        })
      ).json<Invite>();

      await t.request('POST', `/invites/${invite.code}/accept`, { token: member.token });
      const again = await t.request('POST', `/invites/${invite.code}/accept`, {
        token: member.token,
      });
      expect(again.statusCode).toBe(200);
      const [row] = await t.app.ctx.db
        .select()
        .from(schema.invites)
        .where(eq(schema.invites.code, invite.code));
      expect(row?.uses).toBe(1);
    });

    it('enforces the use limit, even under concurrent accepts', async () => {
      const guild = await t.createGuild(owner);
      const invite = (
        await t.request('POST', `/guilds/${guild.id}/invites`, {
          token: owner.token,
          body: { maxUses: 2 },
        })
      ).json<Invite>();

      const friends = await Promise.all([1, 2, 3, 4].map(() => t.account()));
      const results = await Promise.all(
        friends.map((friend) =>
          t.request('POST', `/invites/${invite.code}/accept`, { token: friend.token }),
        ),
      );
      const statuses = results.map((response) => response.statusCode).sort();
      expect(statuses).toEqual([200, 200, 404, 404]);
      expect(results.find((response) => response.statusCode === 404)?.json()).toMatchObject({
        error: 'invite_invalid',
      });
      expect((await getGuild(owner, guild.id)).members).toHaveLength(3);
    });

    it('rejects expired invites', async () => {
      const guild = await t.createGuild(owner);
      const invite = (
        await t.request('POST', `/guilds/${guild.id}/invites`, {
          token: owner.token,
          body: { expiresInSeconds: 3600 },
        })
      ).json<Invite>();
      expect(Date.parse(invite.expiresAt ?? '')).toBeGreaterThan(Date.now() + 3_500_000);

      await t.app.ctx.db
        .update(schema.invites)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.invites.code, invite.code));

      for (const path of [`/invites/${invite.code}`, `/invites/${invite.code}/accept`]) {
        const response = await t.request(path.endsWith('accept') ? 'POST' : 'GET', path, {
          token: member.token,
        });
        expect(response.statusCode).toBe(404);
      }
    });

    it('validates limits and expiry', async () => {
      const guild = await t.createGuild(owner);
      for (const body of [{ maxUses: 0 }, { maxUses: 5000 }, { expiresInSeconds: 5 }]) {
        const response = await t.request('POST', `/guilds/${guild.id}/invites`, {
          token: owner.token,
          body,
        });
        expect(response.statusCode).toBe(400);
      }
    });

    it('requires CREATE_INVITE to create and MANAGE_GUILD to list', async () => {
      const guild = await t.createGuild(owner);
      await t.join(guild, owner, member);

      // Members can invite by default, but cannot see every invite.
      const own = await t.request('POST', `/guilds/${guild.id}/invites`, {
        token: member.token,
        body: {},
      });
      expect(own.statusCode).toBe(201);
      expect(
        (await t.request('GET', `/guilds/${guild.id}/invites`, { token: member.token })).statusCode,
      ).toBe(403);
      expect(
        (await t.request('GET', `/guilds/${guild.id}/invites`, { token: owner.token })).json<
          Invite[]
        >(),
      ).toHaveLength(2);

      // Taking CREATE_INVITE away from @everyone closes that door.
      await t.request('PATCH', `/roles/${guild.id}`, {
        token: owner.token,
        body: { permissions: (DEFAULT_EVERYONE_PERMISSIONS & ~P.CreateInvite).toString() },
      });
      const denied = await t.request('POST', `/guilds/${guild.id}/invites`, {
        token: member.token,
        body: {},
      });
      expect(denied.statusCode).toBe(403);
    });

    it('lets the creator or a manager revoke an invite', async () => {
      const guild = await t.createGuild(owner);
      await t.join(guild, owner, member);
      const other = await t.account();
      await t.join(guild, owner, other);
      const invite = (
        await t.request('POST', `/guilds/${guild.id}/invites`, { token: member.token, body: {} })
      ).json<Invite>();

      expect(
        (await t.request('DELETE', `/invites/${invite.code}`, { token: other.token })).statusCode,
      ).toBe(403);
      expect(
        (await t.request('DELETE', `/invites/${invite.code}`, { token: member.token })).statusCode,
      ).toBe(204);
      expect(
        (await t.request('POST', `/invites/${invite.code}/accept`, { token: outsider.token }))
          .statusCode,
      ).toBe(404);
    });
  });

  describe('members', () => {
    it('lets a member leave, but not the owner', async () => {
      const guild = await t.createGuild(owner);
      await t.join(guild, owner, member);

      const ownerLeaves = await t.request('DELETE', `/guilds/${guild.id}/members/@me`, {
        token: owner.token,
      });
      expect(ownerLeaves.statusCode).toBe(409);

      const memberLeaves = await t.request('DELETE', `/guilds/${guild.id}/members/@me`, {
        token: member.token,
      });
      expect(memberLeaves.statusCode).toBe(204);
      expect(
        (await t.request('GET', `/guilds/${guild.id}`, { token: member.token })).statusCode,
      ).toBe(404);
    });

    it('kicks only with KICK_MEMBERS and only members of lower rank', async () => {
      const guild = await t.createGuild(owner);
      const [mod, peer, newbie] = await Promise.all([t.account(), t.account(), t.account()]);
      for (const account of [mod, peer, newbie]) await t.join(guild, owner, account);
      const kick = (actor: Account, target: Account) =>
        t.request('DELETE', `/guilds/${guild.id}/members/${target.user.id}`, {
          token: actor.token,
        });

      // No permission yet.
      expect((await kick(mod, newbie)).statusCode).toBe(403);

      const modRole = await t.createRole(owner, guild.id, 'Moderador', P.KickMembers);
      await t.setRoles(owner, guild.id, mod, [modRole.id]);
      await t.setRoles(owner, guild.id, peer, [modRole.id]);

      expect((await kick(mod, peer)).statusCode).toBe(403); // same rank
      expect((await kick(mod, owner)).statusCode).toBe(403); // the owner is untouchable
      expect((await kick(mod, mod)).statusCode).toBe(400); // not yourself
      expect((await kick(mod, outsider)).statusCode).toBe(404); // not a member
      expect((await kick(mod, newbie)).statusCode).toBe(204);

      const remaining = (await getGuild(owner, guild.id)).members.map((entry) => entry.user.id);
      expect(remaining).not.toContain(newbie.user.id);
      // The kicked member lost access, and can come back with a new invite.
      expect(
        (await t.request('GET', `/guilds/${guild.id}`, { token: newbie.token })).statusCode,
      ).toBe(404);
    });

    it('lets members set their own nickname, and managers set others', async () => {
      const guild = await t.createGuild(owner);
      await t.join(guild, owner, member);
      const patch = (actor: Account, target: Account, nickname: string | null) =>
        t.request('PATCH', `/guilds/${guild.id}/members/${target.user.id}`, {
          token: actor.token,
          body: { nickname },
        });

      expect((await patch(member, member, 'Apelido')).json()).toMatchObject({
        nickname: 'Apelido',
      });
      expect((await patch(member, owner, 'Chefe')).statusCode).toBe(403);
      expect((await patch(owner, member, null)).json()).toMatchObject({ nickname: null });
    });
  });

  describe('channels', () => {
    const create = (actor: Account, guildId: string, body: object) =>
      t.request('POST', `/guilds/${guildId}/channels`, { token: actor.token, body });

    it('requires MANAGE_CHANNELS to create, edit and delete', async () => {
      const guild = await t.createGuild(owner);
      await t.join(guild, owner, member);

      expect((await create(member, guild.id, { name: 'novo', type: 'text' })).statusCode).toBe(403);
      const created = await create(owner, guild.id, { name: 'novo', type: 'text' });
      expect(created.statusCode).toBe(201);
      const channel = created.json<Channel>();

      expect(
        (
          await t.request('PATCH', `/channels/${channel.id}`, {
            token: member.token,
            body: { name: 'x' },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await t.request('DELETE', `/channels/${channel.id}`, { token: member.token })).statusCode,
      ).toBe(403);

      const edited = await t.request('PATCH', `/channels/${channel.id}`, {
        token: owner.token,
        body: { name: 'avisos', topic: 'Leia antes de postar' },
      });
      expect(edited.json()).toMatchObject({ name: 'avisos', topic: 'Leia antes de postar' });
      expect(
        (await t.request('DELETE', `/channels/${channel.id}`, { token: owner.token })).statusCode,
      ).toBe(204);
      expect(
        (await getGuild(owner, guild.id)).channels.some((entry) => entry.id === channel.id),
      ).toBe(false);
    });

    it('places channels inside categories and appends them in order', async () => {
      const guild = await t.createGuild(owner);
      const category = (
        await create(owner, guild.id, { name: 'Jogos', type: 'category' })
      ).json<Channel>();
      const first = (
        await create(owner, guild.id, { name: 'a', type: 'voice', parentId: category.id })
      ).json<Channel>();
      const second = (
        await create(owner, guild.id, { name: 'b', type: 'voice', parentId: category.id })
      ).json<Channel>();

      expect(category.position).toBe(2); // after the two default categories
      expect([first.position, second.position]).toEqual([0, 1]);
      expect(first.parentId).toBe(category.id);
    });

    it('rejects invalid parents', async () => {
      const guild = await t.createGuild(owner);
      const other = await t.createGuild(owner);
      const text = guild.channels.find((channel) => channel.type === 'text');
      const foreignCategory = other.channels.find((channel) => channel.type === 'category');
      const category = guild.channels.find((channel) => channel.type === 'category');

      const cases = [
        { name: 'x', type: 'text', parentId: text?.id }, // not a category
        { name: 'x', type: 'text', parentId: foreignCategory?.id }, // another guild
        { name: 'x', type: 'category', parentId: category?.id }, // nested category
      ];
      for (const body of cases) {
        expect((await create(owner, guild.id, body)).statusCode).toBe(400);
      }
    });

    it('reorders channels and moves them between categories', async () => {
      const guild = await t.createGuild(owner);
      const [textCategory, voiceCategory] = guild.channels.filter((c) => c.type === 'category');
      const geral = guild.channels.find((channel) => channel.type === 'text');
      const extra = (
        await create(owner, guild.id, { name: 'extra', type: 'text', parentId: textCategory?.id })
      ).json<Channel>();
      if (!textCategory || !voiceCategory || !geral) throw new Error('default channels missing');

      const response = await t.request('PUT', `/guilds/${guild.id}/channels/order`, {
        token: owner.token,
        body: {
          channels: [
            { id: voiceCategory.id, parentId: null },
            { id: textCategory.id, parentId: null },
            { id: extra.id, parentId: textCategory.id },
            { id: geral.id, parentId: voiceCategory.id },
          ],
        },
      });
      expect(response.statusCode).toBe(204);

      const channels = (await getGuild(owner, guild.id)).channels;
      const find = (id: string) => channels.find((channel) => channel.id === id);
      expect(find(voiceCategory.id)?.position).toBe(0);
      expect(find(textCategory.id)?.position).toBe(1);
      expect(find(extra.id)).toMatchObject({ parentId: textCategory.id, position: 0 });
      expect(find(geral.id)).toMatchObject({ parentId: voiceCategory.id, position: 0 });
    });

    it('keeps the children of a deleted category', async () => {
      const guild = await t.createGuild(owner);
      const category = guild.channels.find((channel) => channel.name === 'Texto');
      const child = guild.channels.find((channel) => channel.type === 'text');
      await t.request('DELETE', `/channels/${category?.id}`, { token: owner.token });

      const channels = (await getGuild(owner, guild.id)).channels;
      expect(channels.find((channel) => channel.id === child?.id)?.parentId).toBeNull();
    });
  });
});
