import {
  DEFAULT_EVERYONE_PERMISSIONS,
  Permissions as P,
  type Channel,
  type Guild,
  type Role,
} from '@frequencia/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type Account, type TestApp } from './helpers/app';

describe('roles and permissions over the API', () => {
  let t: TestApp;
  let owner: Account;

  beforeAll(async () => {
    t = await createTestApp();
    owner = await t.account('Dona');
  });

  afterAll(async () => {
    await t.close();
  });

  const getGuild = async (account: Account, guildId: string) =>
    (await t.request('GET', `/guilds/${guildId}`, { token: account.token })).json<Guild>();

  /** A guild with the owner and freshly joined members. */
  async function guildWith(count: number) {
    const guild = await t.createGuild(owner);
    const members = await Promise.all(Array.from({ length: count }, () => t.account()));
    for (const account of members) await t.join(guild, owner, account);
    return { guild, members };
  }

  describe('roles', () => {
    it('creates roles at the bottom of the hierarchy', async () => {
      const { guild } = await guildWith(0);
      const first = await t.createRole(owner, guild.id, 'Primeiro', P.KickMembers);
      const second = await t.createRole(owner, guild.id, 'Segundo');

      expect(first).toMatchObject({ name: 'Primeiro', permissions: P.KickMembers.toString() });
      const roles = (await getGuild(owner, guild.id)).roles;
      expect(roles.map((role) => [role.name, role.position])).toEqual([
        ['Primeiro', 2],
        ['Segundo', 1],
        ['@everyone', 0],
      ]);
      expect(second.position).toBe(1);
    });

    it('requires MANAGE_ROLES', async () => {
      const { guild, members } = await guildWith(1);
      const [member] = members as [Account];
      const response = await t.request('POST', `/guilds/${guild.id}/roles`, {
        token: member.token,
        body: { name: 'Meu cargo' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('does not let a manager grant permissions they do not hold', async () => {
      const { guild, members } = await guildWith(1);
      const [manager] = members as [Account];
      const managerRole = await t.createRole(owner, guild.id, 'Gerente', P.ManageRoles);
      await t.setRoles(owner, guild.id, manager, [managerRole.id]);
      const create = (permissions: bigint) =>
        t.request('POST', `/guilds/${guild.id}/roles`, {
          token: manager.token,
          body: { name: 'Novo', permissions: permissions.toString() },
        });

      expect((await create(P.Administrator)).statusCode).toBe(403);
      expect((await create(P.KickMembers)).statusCode).toBe(403);
      // Their own permissions (@everyone + ManageRoles) are fine.
      expect((await create(P.ManageRoles | P.SendMessages)).statusCode).toBe(201);
    });

    it('only lets a manager edit roles below their own', async () => {
      const { guild, members } = await guildWith(1);
      const [manager] = members as [Account];
      const high = await t.createRole(owner, guild.id, 'Alto', P.ManageRoles);
      const mid = await t.createRole(owner, guild.id, 'Meio', P.ManageRoles);
      const low = await t.createRole(owner, guild.id, 'Baixo');
      await t.setRoles(owner, guild.id, manager, [mid.id]);
      const rename = (role: Role) =>
        t.request('PATCH', `/roles/${role.id}`, {
          token: manager.token,
          body: { name: 'Editado' },
        });

      expect((await rename(high)).statusCode).toBe(403);
      expect((await rename(mid)).statusCode).toBe(403); // their own highest role
      expect((await rename(low)).statusCode).toBe(200);
      expect(
        (await t.request('DELETE', `/roles/${high.id}`, { token: manager.token })).statusCode,
      ).toBe(403);
      expect(
        (await t.request('DELETE', `/roles/${low.id}`, { token: manager.token })).statusCode,
      ).toBe(204);
    });

    it('only checks the permission bits being changed', async () => {
      const { guild, members } = await guildWith(1);
      const [manager] = members as [Account];
      const managerRole = await t.createRole(owner, guild.id, 'Gerente', P.ManageRoles);
      const target = await t.createRole(owner, guild.id, 'Alvo', P.KickMembers);
      await t.setRoles(owner, guild.id, manager, [managerRole.id]);
      const setPermissions = (permissions: bigint) =>
        t.request('PATCH', `/roles/${target.id}`, {
          token: manager.token,
          body: { permissions: permissions.toString() },
        });

      // Keeping KickMembers (which the manager lacks) while adding one they have is fine...
      expect((await setPermissions(P.KickMembers | P.SendMessages)).statusCode).toBe(200);
      // ...but they can neither remove it nor add another they lack.
      expect((await setPermissions(P.SendMessages)).statusCode).toBe(403);
      expect((await setPermissions(P.KickMembers | P.ManageGuild)).statusCode).toBe(403);
    });

    it('protects @everyone from deletion and renaming, but lets it be edited', async () => {
      const { guild } = await guildWith(0);
      expect(
        (await t.request('DELETE', `/roles/${guild.id}`, { token: owner.token })).statusCode,
      ).toBe(400);
      expect(
        (
          await t.request('PATCH', `/roles/${guild.id}`, {
            token: owner.token,
            body: { name: 'todos' },
          })
        ).statusCode,
      ).toBe(400);
      const edited = await t.request('PATCH', `/roles/${guild.id}`, {
        token: owner.token,
        body: { permissions: P.ViewChannel.toString() },
      });
      expect(edited.json<Role>().permissions).toBe(P.ViewChannel.toString());
    });

    it('closes the gap in positions when a role is deleted', async () => {
      const { guild } = await guildWith(0);
      const a = await t.createRole(owner, guild.id, 'A');
      const b = await t.createRole(owner, guild.id, 'B');
      await t.createRole(owner, guild.id, 'C');
      await t.request('DELETE', `/roles/${b.id}`, { token: owner.token });

      const roles = (await getGuild(owner, guild.id)).roles;
      expect(roles.map((role) => [role.name, role.position])).toEqual([
        ['A', 2],
        ['C', 1],
        ['@everyone', 0],
      ]);
      expect(a.id).toBeTruthy();
    });

    it('rejects malformed permission values', async () => {
      const { guild } = await guildWith(0);
      for (const permissions of ['abc', '-1', (1n << 40n).toString()]) {
        const response = await t.request('POST', `/guilds/${guild.id}/roles`, {
          token: owner.token,
          body: { name: 'X', permissions },
        });
        expect(response.statusCode).toBe(400);
      }
    });
  });

  describe('hierarchy', () => {
    it('reorders roles, highest first', async () => {
      const { guild } = await guildWith(0);
      const a = await t.createRole(owner, guild.id, 'A');
      const b = await t.createRole(owner, guild.id, 'B');
      const c = await t.createRole(owner, guild.id, 'C');

      const response = await t.request('PUT', `/guilds/${guild.id}/roles/order`, {
        token: owner.token,
        body: { roleIds: [c.id, a.id, b.id] },
      });
      expect(response.json<Role[]>().map((role) => [role.name, role.position])).toEqual([
        ['C', 3],
        ['A', 2],
        ['B', 1],
        ['@everyone', 0],
      ]);
    });

    it('requires the complete list of roles', async () => {
      const { guild } = await guildWith(0);
      const a = await t.createRole(owner, guild.id, 'A');
      await t.createRole(owner, guild.id, 'B');
      for (const roleIds of [[a.id], [a.id, a.id], [a.id, guild.id]]) {
        const response = await t.request('PUT', `/guilds/${guild.id}/roles/order`, {
          token: owner.token,
          body: { roleIds },
        });
        expect(response.statusCode).toBe(400);
      }
    });

    it('does not let a manager lift a role to their own level or move higher ones', async () => {
      const { guild, members } = await guildWith(1);
      const [manager] = members as [Account];
      const top = await t.createRole(owner, guild.id, 'Topo');
      const mine = await t.createRole(owner, guild.id, 'Gerente', P.ManageRoles);
      const lowA = await t.createRole(owner, guild.id, 'A');
      const lowB = await t.createRole(owner, guild.id, 'B');
      await t.setRoles(owner, guild.id, manager, [mine.id]);
      const reorder = (roleIds: string[]) =>
        t.request('PUT', `/guilds/${guild.id}/roles/order`, {
          token: manager.token,
          body: { roleIds },
        });

      // Swapping the two roles below them is allowed.
      expect((await reorder([top.id, mine.id, lowB.id, lowA.id])).statusCode).toBe(200);
      // Promoting a lower role above themselves is not.
      expect((await reorder([top.id, lowA.id, mine.id, lowB.id])).statusCode).toBe(403);
      // Neither is touching the role above.
      expect((await reorder([mine.id, top.id, lowB.id, lowA.id])).statusCode).toBe(403);
    });

    it('only lets a manager assign and remove roles below their own', async () => {
      const { guild, members } = await guildWith(2);
      const [manager, target] = members as [Account, Account];
      const high = await t.createRole(owner, guild.id, 'Alto');
      const mine = await t.createRole(owner, guild.id, 'Gerente', P.ManageRoles);
      const low = await t.createRole(owner, guild.id, 'Baixo');
      await t.setRoles(owner, guild.id, manager, [mine.id]);
      await t.setRoles(owner, guild.id, target, [high.id]);
      const assign = (roleIds: string[]) =>
        t.request('PATCH', `/guilds/${guild.id}/members/${target.user.id}`, {
          token: manager.token,
          body: { roleIds },
        });

      expect((await assign([high.id, low.id])).statusCode).toBe(200); // adds a lower role
      expect((await assign([high.id, low.id, mine.id])).statusCode).toBe(403); // own level
      expect((await assign([low.id])).statusCode).toBe(403); // would remove a higher role
      expect((await assign([high.id])).statusCode).toBe(200); // removes the lower role again
      expect((await assign([guild.id])).statusCode).toBe(400); // @everyone is implicit
    });

    it('prevents privilege escalation by self-assignment', async () => {
      const { guild, members } = await guildWith(1);
      const [manager] = members as [Account];
      const admin = await t.createRole(owner, guild.id, 'Admin', P.Administrator);
      const mine = await t.createRole(owner, guild.id, 'Gerente', P.ManageRoles);
      await t.setRoles(owner, guild.id, manager, [mine.id]);

      const response = await t.request('PATCH', `/guilds/${guild.id}/members/${manager.user.id}`, {
        token: manager.token,
        body: { roleIds: [mine.id, admin.id] },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe('channel overwrites', () => {
    const putOverwrite = (actor: Account, channelId: string, targetId: string, body: object) =>
      t.request('PUT', `/channels/${channelId}/overwrites/${targetId}`, {
        token: actor.token,
        body,
      });
    const role = (allow: bigint, deny: bigint) => ({
      targetType: 'role',
      allow: allow.toString(),
      deny: deny.toString(),
    });

    it('hides a private channel from members without the allowed role', async () => {
      const { guild, members } = await guildWith(2);
      const [vip, regular] = members as [Account, Account];
      const vipRole = await t.createRole(owner, guild.id, 'VIP');
      await t.setRoles(owner, guild.id, vip, [vipRole.id]);
      const secret = (
        await t.request('POST', `/guilds/${guild.id}/channels`, {
          token: owner.token,
          body: { name: 'segredo', type: 'voice' },
        })
      ).json<Channel>();

      await putOverwrite(owner, secret.id, guild.id, role(0n, P.ViewChannel));
      const updated = await putOverwrite(owner, secret.id, vipRole.id, role(P.ViewChannel, 0n));
      expect(updated.json<Channel>().overwrites).toHaveLength(2);

      const ids = async (account: Account) =>
        (await getGuild(account, guild.id)).channels.map((channel) => channel.id);
      expect(await ids(vip)).toContain(secret.id);
      expect(await ids(owner)).toContain(secret.id);
      expect(await ids(regular)).not.toContain(secret.id);

      // Hidden channels behave as if they did not exist.
      const edit = await t.request('PATCH', `/channels/${secret.id}`, {
        token: regular.token,
        body: { name: 'achei' },
      });
      expect(edit.statusCode).toBe(404);
      const token = await t.request('POST', `/channels/${secret.id}/voice-token`, {
        token: regular.token,
      });
      expect(token.statusCode).toBe(404);
    });

    it('applies category overwrites to the channels inside it', async () => {
      const { guild, members } = await guildWith(1);
      const [regular] = members as [Account];
      const category = guild.channels.find((channel) => channel.name === 'Voz');
      const voice = guild.channels.find((channel) => channel.type === 'voice');
      if (!category || !voice) throw new Error('default channels missing');

      await putOverwrite(owner, category.id, guild.id, role(0n, P.ViewChannel));
      const visible = (await getGuild(regular, guild.id)).channels.map((channel) => channel.id);
      expect(visible).not.toContain(category.id);
      expect(visible).not.toContain(voice.id);

      // The channel can opt back in.
      await putOverwrite(owner, voice.id, guild.id, role(P.ViewChannel, 0n));
      expect((await getGuild(regular, guild.id)).channels.map((c) => c.id)).toContain(voice.id);
    });

    it('supports overwrites for a single member and their removal', async () => {
      const { guild, members } = await guildWith(1);
      const [target] = members as [Account];
      const text = guild.channels.find((channel) => channel.type === 'text');
      if (!text) throw new Error('default channel missing');

      await putOverwrite(owner, text.id, target.user.id, {
        targetType: 'member',
        allow: '0',
        deny: P.ViewChannel.toString(),
      });
      expect((await getGuild(target, guild.id)).channels.map((c) => c.id)).not.toContain(text.id);

      const removed = await t.request(
        'DELETE',
        `/channels/${text.id}/overwrites/${target.user.id}`,
        { token: owner.token },
      );
      expect(removed.json<Channel>().overwrites).toEqual([]);
      expect((await getGuild(target, guild.id)).channels.map((c) => c.id)).toContain(text.id);
    });

    it('requires MANAGE_ROLES and respects the hierarchy and own permissions', async () => {
      const { guild, members } = await guildWith(1);
      const [manager] = members as [Account];
      const text = guild.channels.find((channel) => channel.type === 'text');
      const high = await t.createRole(owner, guild.id, 'Alto');
      const mine = await t.createRole(owner, guild.id, 'Gerente', P.ManageRoles);
      const low = await t.createRole(owner, guild.id, 'Baixo');
      if (!text) throw new Error('default channel missing');

      // Without the permission nothing goes.
      expect(
        (await putOverwrite(manager, text.id, low.id, role(0n, P.SendMessages))).statusCode,
      ).toBe(403);
      await t.setRoles(owner, guild.id, manager, [mine.id]);

      expect(
        (await putOverwrite(manager, text.id, low.id, role(0n, P.SendMessages))).statusCode,
      ).toBe(200);
      expect(
        (await putOverwrite(manager, text.id, high.id, role(0n, P.SendMessages))).statusCode,
      ).toBe(403);
      // ManageMessages is not theirs to hand out.
      expect(
        (await putOverwrite(manager, text.id, low.id, role(P.ManageMessages, 0n))).statusCode,
      ).toBe(403);
      // Unknown targets are rejected.
      expect(
        (await putOverwrite(manager, text.id, text.id, role(0n, P.SendMessages))).statusCode,
      ).toBe(400);
    });

    it('never lets an overwrite hand out administrator', async () => {
      const { guild, members } = await guildWith(1);
      const [target] = members as [Account];
      const text = guild.channels.find((channel) => channel.type === 'text');
      if (!text) throw new Error('default channel missing');

      const response = await putOverwrite(owner, text.id, target.user.id, {
        targetType: 'member',
        allow: (P.Administrator | P.ManageMessages).toString(),
        deny: '0',
      });
      expect(response.json<Channel>().overwrites[0]?.allow).toBe(P.ManageMessages.toString());
    });

    it('drops the overwrites of a deleted role and of a member who leaves', async () => {
      const { guild, members } = await guildWith(1);
      const [leaver] = members as [Account];
      const text = guild.channels.find((channel) => channel.type === 'text');
      const temp = await t.createRole(owner, guild.id, 'Temporário');
      if (!text) throw new Error('default channel missing');
      await putOverwrite(owner, text.id, temp.id, role(0n, P.SendMessages));
      await putOverwrite(owner, text.id, leaver.user.id, {
        targetType: 'member',
        allow: P.ManageMessages.toString(),
        deny: '0',
      });

      await t.request('DELETE', `/roles/${temp.id}`, { token: owner.token });
      await t.request('DELETE', `/guilds/${guild.id}/members/@me`, { token: leaver.token });

      const channel = (await getGuild(owner, guild.id)).channels.find((c) => c.id === text.id);
      expect(channel?.overwrites).toEqual([]);
    });
  });

  describe('voice tokens', () => {
    it('reflects the member permissions in the token claims', async () => {
      const { guild, members } = await guildWith(1);
      const [member] = members as [Account];
      const voice = guild.channels.find((channel) => channel.type === 'voice');
      if (!voice) throw new Error('default channel missing');
      const claims = async () => {
        const response = await t.request('POST', `/channels/${voice.id}/voice-token`, {
          token: member.token,
        });
        expect(response.statusCode).toBe(200);
        const { token } = response.json<{ token: string }>();
        return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as {
          sub: string;
          room: string;
          speak: boolean;
          stream: boolean;
          exp: number;
          iat: number;
        };
      };

      const full = await claims();
      expect(full).toMatchObject({
        sub: member.user.id,
        room: voice.id,
        speak: true,
        stream: true,
      });
      expect(full.exp - full.iat).toBe(60);

      // A listen-only channel: connect stays, speak and stream go.
      await t.request('PUT', `/channels/${voice.id}/overwrites/${guild.id}`, {
        token: owner.token,
        body: { targetType: 'role', allow: '0', deny: (P.Speak | P.Stream).toString() },
      });
      expect(await claims()).toMatchObject({ speak: false, stream: false });
    });

    it('requires CONNECT, a voice channel and membership', async () => {
      const { guild, members } = await guildWith(1);
      const [member] = members as [Account];
      const outsider = await t.account();
      const voice = guild.channels.find((channel) => channel.type === 'voice');
      const text = guild.channels.find((channel) => channel.type === 'text');
      const tokenFor = (account: Account, channelId: string | undefined) =>
        t.request('POST', `/channels/${channelId}/voice-token`, { token: account.token });

      expect((await tokenFor(outsider, voice?.id)).statusCode).toBe(404);
      expect((await tokenFor(member, text?.id)).statusCode).toBe(404);

      await t.request('PATCH', `/roles/${guild.id}`, {
        token: owner.token,
        body: { permissions: (DEFAULT_EVERYONE_PERMISSIONS & ~P.Connect).toString() },
      });
      const denied = await tokenFor(member, voice?.id);
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ error: 'forbidden' });
      // The owner is never locked out.
      expect((await tokenFor(owner, voice?.id)).statusCode).toBe(200);
    });
  });
});
