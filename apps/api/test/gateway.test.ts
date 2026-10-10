import {
  GatewayCloseCode,
  GatewayOp,
  Permissions as P,
  type Channel,
  type Guild,
} from '@frequencia/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type Account, type TestApp } from './helpers/app';
import { connectGateway, type GatewayClient } from './helpers/gateway';

describe('gateway', () => {
  let t: TestApp;
  const clients: GatewayClient[] = [];

  const connect = async (app: TestApp = t) => {
    const client = await connectGateway(app.wsUrl);
    clients.push(client);
    return client;
  };
  /** Connects and identifies in one go. */
  const online = async (account: Account, app: TestApp = t) => {
    const client = await connect(app);
    const ready = await client.identify(account.token);
    return { client, ready };
  };

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  afterAll(async () => {
    await t.close();
  });

  describe('handshake', () => {
    it('greets with the heartbeat interval, then answers identify with READY', async () => {
      const account = await t.account('Alice');
      const guild = await t.createGuild(account, 'Meu servidor');
      const client = await connect();

      const hello = await client.nextControl(GatewayOp.Hello);
      expect(hello.d).toEqual({ heartbeatInterval: 30_000 });

      const ready = await client.identify(account.token);
      expect(ready.user).toEqual(account.user);
      expect(ready.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(ready.guilds).toHaveLength(1);
      expect(ready.guilds[0]).toMatchObject({
        id: guild.id,
        name: 'Meu servidor',
        onlineUserIds: [account.user.id],
        voiceStates: [],
      });
      expect(ready.guilds[0]?.channels).toHaveLength(4);
      expect(client.dispatches[0]).toMatchObject({ t: 'READY', s: 1 });
    });

    it('closes the connection when the token is invalid', async () => {
      const client = await connect();
      client.send({ op: GatewayOp.Identify, d: { token: 'garbage' } });
      await expect(client.closed).resolves.toBe(GatewayCloseCode.AuthenticationFailed);
    });

    it('rejects a token whose session was logged out', async () => {
      const account = await t.account();
      await t.request('POST', '/auth/logout', { cookie: account.cookie });
      const client = await connect();
      client.send({ op: GatewayOp.Identify, d: { token: account.token } });
      await expect(client.closed).resolves.toBe(GatewayCloseCode.AuthenticationFailed);
    });

    it('refuses a second identify on the same connection', async () => {
      const account = await t.account();
      const { client } = await online(account);
      client.send({ op: GatewayOp.Identify, d: { token: account.token } });
      await expect(client.closed).resolves.toBe(GatewayCloseCode.AlreadyAuthenticated);
    });

    it('closes on frames it cannot decode', async () => {
      const malformed = await connect();
      malformed.socket.send('not json');
      await expect(malformed.closed).resolves.toBe(GatewayCloseCode.DecodeError);

      const unknownOp = await connect();
      unknownOp.send({ op: 99, d: {} });
      await expect(unknownOp.closed).resolves.toBe(GatewayCloseCode.DecodeError);
    });
  });

  describe('heartbeat', () => {
    let fast: TestApp;

    beforeAll(async () => {
      fast = await createTestApp({ GATEWAY_HEARTBEAT_MS: '150' });
    });

    afterAll(async () => {
      await fast.close();
    });

    it('acknowledges heartbeats and keeps a beating connection open', async () => {
      const account = await fast.account();
      const { client } = await online(account, fast);
      for (let i = 0; i < 5; i++) {
        client.heartbeat();
        await client.nextControl(GatewayOp.HeartbeatAck);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(client.socket.readyState).toBe(client.socket.OPEN);
    });

    it('drops connections that never identify', async () => {
      const client = await connect(fast);
      await expect(client.closed).resolves.toBe(GatewayCloseCode.NotAuthenticated);
    });

    it('drops identified connections that stop sending heartbeats', async () => {
      const account = await fast.account();
      const { client } = await online(account, fast);
      await expect(client.closed).resolves.toBe(GatewayCloseCode.SessionTimedOut);
    });
  });

  describe('rate limiting', () => {
    it('closes connections that flood the gateway', async () => {
      const limited = await createTestApp({ GATEWAY_RATE_LIMIT: '10' });
      try {
        const account = await limited.account();
        const { client } = await online(account, limited);
        for (let i = 0; i < 30; i++) client.heartbeat();
        await expect(client.closed).resolves.toBe(GatewayCloseCode.RateLimited);
      } finally {
        await limited.close();
      }
    });
  });

  describe('events', () => {
    it('announces a new member to the guild and sends the guild to the newcomer', async () => {
      const [owner, friend] = await Promise.all([t.account('Dona'), t.account('Amigo')]);
      const guild = await t.createGuild(owner);
      const ownerSocket = (await online(owner)).client;
      const friendSocket = (await online(friend)).client;

      await t.join(guild, owner, friend);

      const added = await ownerSocket.next('MEMBER_ADD');
      expect(added).toMatchObject({ guildId: guild.id, member: { user: friend.user } });
      const created = await friendSocket.next('GUILD_CREATE');
      expect(created.id).toBe(guild.id);
      expect(created.members).toHaveLength(2);
      // Both are connected, so both show as online to the newcomer.
      expect(created.onlineUserIds.sort()).toEqual([owner.user.id, friend.user.id].sort());
    });

    it('delivers a guild created over REST to the creator sockets', async () => {
      const owner = await t.account();
      const { client } = await online(owner);
      const guild = await t.createGuild(owner, 'Novo');
      expect((await client.next('GUILD_CREATE')).id).toBe(guild.id);

      await t.request('PATCH', `/guilds/${guild.id}`, {
        token: owner.token,
        body: { name: 'Renomeado' },
      });
      expect(await client.next('GUILD_UPDATE')).toEqual({
        id: guild.id,
        name: 'Renomeado',
        icon: null,
      });
    });

    it('broadcasts channel changes only to members who can see the channel', async () => {
      const [owner, vip, regular] = await Promise.all([t.account(), t.account(), t.account()]);
      const guild = await t.createGuild(owner);
      await t.join(guild, owner, vip);
      await t.join(guild, owner, regular);
      const vipRole = await t.createRole(owner, guild.id, 'VIP');
      await t.setRoles(owner, guild.id, vip, [vipRole.id]);

      // A private category: only VIPs see what is inside.
      const category = (
        await t.request('POST', `/guilds/${guild.id}/channels`, {
          token: owner.token,
          body: { name: 'Privado', type: 'category' },
        })
      ).json<Channel>();
      for (const [targetId, allow, deny] of [
        [guild.id, 0n, P.ViewChannel],
        [vipRole.id, P.ViewChannel, 0n],
      ] as const) {
        await t.request('PUT', `/channels/${category.id}/overwrites/${targetId}`, {
          token: owner.token,
          body: { targetType: 'role', allow: allow.toString(), deny: deny.toString() },
        });
      }

      const vipSocket = (await online(vip)).client;
      const regularSocket = (await online(regular)).client;

      const created = (
        await t.request('POST', `/guilds/${guild.id}/channels`, {
          token: owner.token,
          body: { name: 'sala-vip', type: 'voice', parentId: category.id },
        })
      ).json<Channel>();
      expect((await vipSocket.next('CHANNEL_CREATE')).id).toBe(created.id);

      await t.request('PATCH', `/channels/${created.id}`, {
        token: owner.token,
        body: { name: 'sala-vip-2' },
      });
      expect((await vipSocket.next('CHANNEL_UPDATE')).name).toBe('sala-vip-2');

      await t.request('DELETE', `/channels/${created.id}`, { token: owner.token });
      expect(await vipSocket.next('CHANNEL_DELETE')).toEqual({ id: created.id, guildId: guild.id });

      await regularSocket.expectNone('CHANNEL_CREATE');
      await regularSocket.expectNone('CHANNEL_UPDATE');
      await regularSocket.expectNone('CHANNEL_DELETE');
    });

    it('resyncs the guild for each member when permissions change', async () => {
      const [owner, member] = await Promise.all([t.account(), t.account()]);
      const guild = await t.createGuild(owner);
      await t.join(guild, owner, member);
      const text = guild.channels.find((channel) => channel.type === 'text');
      const ownerSocket = (await online(owner)).client;
      const memberSocket = (await online(member)).client;

      // Hide the text channel from @everyone.
      await t.request('PUT', `/channels/${text?.id}/overwrites/${guild.id}`, {
        token: owner.token,
        body: { targetType: 'role', allow: '0', deny: P.ViewChannel.toString() },
      });
      const forMember = await memberSocket.next('GUILD_SYNC');
      const forOwner = await ownerSocket.next('GUILD_SYNC');
      expect(forMember.channels.map((channel) => channel.id)).not.toContain(text?.id);
      expect(forOwner.channels.map((channel) => channel.id)).toContain(text?.id);

      // A new role shows up for everyone, and assigning it restores access.
      const role = await t.createRole(owner, guild.id, 'Leitor');
      expect((await memberSocket.next('GUILD_SYNC')).roles.map((r) => r.id)).toContain(role.id);
      await t.request('PUT', `/channels/${text?.id}/overwrites/${role.id}`, {
        token: owner.token,
        body: { targetType: 'role', allow: P.ViewChannel.toString(), deny: '0' },
      });
      await memberSocket.next('GUILD_SYNC');
      await t.setRoles(owner, guild.id, member, [role.id]);

      const update = await memberSocket.next('MEMBER_UPDATE');
      expect(update.member).toMatchObject({ user: member.user, roleIds: [role.id] });
      const restored = await memberSocket.next('GUILD_SYNC');
      expect(restored.channels.map((channel) => channel.id)).toContain(text?.id);
    });

    it('removes the guild from a kicked member and tells the others', async () => {
      const [owner, target] = await Promise.all([t.account(), t.account()]);
      const guild = await t.createGuild(owner);
      await t.join(guild, owner, target);
      const ownerSocket = (await online(owner)).client;
      const targetSocket = (await online(target)).client;

      await t.request('DELETE', `/guilds/${guild.id}/members/${target.user.id}`, {
        token: owner.token,
      });
      expect(await targetSocket.next('GUILD_DELETE')).toEqual({ id: guild.id });
      expect(await ownerSocket.next('MEMBER_REMOVE')).toEqual({
        guildId: guild.id,
        userId: target.user.id,
      });

      // The kicked member no longer hears anything about the guild.
      await t.request('PATCH', `/guilds/${guild.id}`, {
        token: owner.token,
        body: { name: 'Sem você' },
      });
      await ownerSocket.next('GUILD_UPDATE');
      await targetSocket.expectNone('GUILD_UPDATE');
    });

    it('tells every member when the guild is deleted', async () => {
      const [owner, member] = await Promise.all([t.account(), t.account()]);
      const guild = await t.createGuild(owner);
      await t.join(guild, owner, member);
      const sockets = [(await online(owner)).client, (await online(member)).client];

      await t.request('DELETE', `/guilds/${guild.id}`, { token: owner.token });
      for (const socket of sockets) {
        expect(await socket.next('GUILD_DELETE')).toEqual({ id: guild.id });
      }
    });

    it('does not leak events between unrelated guilds', async () => {
      const [alice, bob] = await Promise.all([t.account(), t.account()]);
      const aliceGuild = await t.createGuild(alice);
      await t.createGuild(bob);
      const bobSocket = (await online(bob)).client;

      await t.request('PATCH', `/guilds/${aliceGuild.id}`, {
        token: alice.token,
        body: { name: 'Só da Alice' },
      });
      await t.request('POST', `/guilds/${aliceGuild.id}/channels`, {
        token: alice.token,
        body: { name: 'privado', type: 'text' },
      });
      await bobSocket.expectNone('GUILD_UPDATE');
      await bobSocket.expectNone('CHANNEL_CREATE');
    });
  });

  describe('presence', () => {
    it('tells guild members when someone comes online and goes offline', async () => {
      const short = await createTestApp({ GATEWAY_RESUME_WINDOW_MS: '100' });
      try {
        const [owner, friend] = await Promise.all([short.account(), short.account()]);
        const guild = await short.createGuild(owner);
        await short.join(guild, owner, friend);
        const { client: ownerSocket, ready } = await online(owner, short);
        expect(ready.guilds[0]?.onlineUserIds).toEqual([owner.user.id]);

        const { client: friendSocket } = await online(friend, short);
        expect(await ownerSocket.next('PRESENCE_UPDATE')).toEqual({
          userId: friend.user.id,
          status: 'online',
        });

        // A second connection of the same user changes nothing...
        const { client: secondTab } = await online(friend, short);
        await ownerSocket.expectNone('PRESENCE_UPDATE');
        // ...and neither does closing just one of them.
        await friendSocket.close();
        await ownerSocket.expectNone('PRESENCE_UPDATE', 400);

        await secondTab.close();
        expect(await ownerSocket.next('PRESENCE_UPDATE')).toEqual({
          userId: friend.user.id,
          status: 'offline',
        });
      } finally {
        await short.close();
      }
    });

    it('keeps a user online during the resume window', async () => {
      const [owner, friend] = await Promise.all([t.account(), t.account()]);
      const guild = await t.createGuild(owner);
      await t.join(guild, owner, friend);
      const { client: ownerSocket } = await online(owner);
      const { client: friendSocket } = await online(friend);
      await ownerSocket.next('PRESENCE_UPDATE');

      await friendSocket.drop();
      await ownerSocket.expectNone('PRESENCE_UPDATE', 400);
      const snapshot = await t.request('GET', `/guilds/${guild.id}`, { token: owner.token });
      expect(snapshot.json<Guild>().onlineUserIds).toContain(friend.user.id);
    });
  });

  describe('resume', () => {
    it('replays, in order, exactly what was missed while disconnected', async () => {
      const owner = await t.account();
      const guild = await t.createGuild(owner);
      const { client, ready } = await online(owner);
      await t.request('PATCH', `/guilds/${guild.id}`, { token: owner.token, body: { name: 'Um' } });
      await client.next('GUILD_UPDATE');
      const seenSeq = client.seq();
      expect(seenSeq).toBe(2);

      await client.drop();
      for (const name of ['Dois', 'Três']) {
        await t.request('PATCH', `/guilds/${guild.id}`, { token: owner.token, body: { name } });
      }
      // Let the dispatches reach the detached session before resuming.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const resumed = await connect();
      resumed.resume(owner.token, ready.sessionId, seenSeq);
      await resumed.next('RESUMED');
      expect(resumed.dispatches.map((entry) => [entry.s, entry.t])).toEqual([
        [3, 'GUILD_UPDATE'],
        [4, 'GUILD_UPDATE'],
        [5, 'RESUMED'],
      ]);
      expect(resumed.dispatches.slice(0, 2).map((entry) => entry.d)).toEqual([
        { id: guild.id, name: 'Dois', icon: null },
        { id: guild.id, name: 'Três', icon: null },
      ]);

      // The resumed connection keeps receiving live events with consecutive sequence numbers.
      await t.request('PATCH', `/guilds/${guild.id}`, {
        token: owner.token,
        body: { name: 'Quatro' },
      });
      await resumed.next('GUILD_UPDATE', (data) => data.name === 'Quatro');
      expect(resumed.seq()).toBe(6);
    });

    it('answers INVALID_SESSION for unknown sessions and accepts a fresh identify', async () => {
      const account = await t.account();
      const client = await connect();
      client.resume(account.token, '00000000-0000-4000-8000-000000000000', 5);

      const invalid = await client.nextControl(GatewayOp.InvalidSession);
      expect(invalid.d).toEqual({ resumable: false });
      const ready = await client.identify(account.token);
      expect(ready.user.id).toBe(account.user.id);
    });

    it("does not let one user resume another user's session", async () => {
      const [alice, mallory] = await Promise.all([t.account(), t.account()]);
      const { client: aliceSocket, ready } = await online(alice);
      await aliceSocket.drop();

      const attacker = await connect();
      attacker.resume(mallory.token, ready.sessionId, 1);
      await attacker.nextControl(GatewayOp.InvalidSession);
    });

    it('refuses to resume from a sequence number the server never sent', async () => {
      const account = await t.account();
      const { client, ready } = await online(account);
      await client.drop();

      const resumed = await connect();
      resumed.resume(account.token, ready.sessionId, 999);
      await resumed.nextControl(GatewayOp.InvalidSession);
    });

    it('expires sessions that are not resumed in time', async () => {
      const short = await createTestApp({ GATEWAY_RESUME_WINDOW_MS: '100' });
      try {
        const account = await short.account();
        const { client, ready } = await online(account, short);
        await client.drop();
        await new Promise((resolve) => setTimeout(resolve, 300));

        const late = await connect(short);
        late.resume(account.token, ready.sessionId, 1);
        await late.nextControl(GatewayOp.InvalidSession);
        expect(short.app.ctx.hub.sessionCount).toBe(0);
      } finally {
        await short.close();
      }
    });
  });

  describe('revocation', () => {
    it('disconnects the sockets of a session that logs out', async () => {
      const account = await t.account();
      const other = await t.request('POST', '/auth/login', {
        body: { username: account.user.username, password: account.password },
      });
      const { client: loggedOut } = await online(account);
      const stillIn = await connect();
      await stillIn.identify(other.json<{ accessToken: string }>().accessToken);

      await t.request('POST', '/auth/logout', { cookie: account.cookie });
      await expect(loggedOut.closed).resolves.toBe(GatewayCloseCode.AuthenticationFailed);
      expect(stillIn.socket.readyState).toBe(stillIn.socket.OPEN);
    });
  });

  describe('multiple API instances', () => {
    it('delivers events and presence across instances through Redis', async () => {
      const second = await createTestApp();
      try {
        const [owner, friend] = await Promise.all([t.account(), t.account()]);
        const guild = await t.createGuild(owner);
        await t.join(guild, owner, friend);

        // The owner is connected to one instance, the friend to the other.
        const { client: ownerSocket } = await online(owner, t);
        const { client: friendSocket, ready } = await online(friend, second);
        expect(ready.guilds[0]?.onlineUserIds.sort()).toEqual(
          [owner.user.id, friend.user.id].sort(),
        );
        expect(await ownerSocket.next('PRESENCE_UPDATE')).toMatchObject({
          userId: friend.user.id,
          status: 'online',
        });

        // A REST call handled by the first instance reaches the socket on the second...
        await t.request('PATCH', `/guilds/${guild.id}`, {
          token: owner.token,
          body: { name: 'Via instância 1' },
        });
        expect((await friendSocket.next('GUILD_UPDATE')).name).toBe('Via instância 1');

        // ...and the other way around.
        await second.request('POST', `/guilds/${guild.id}/channels`, {
          token: owner.token,
          body: { name: 'via-instancia-2', type: 'text' },
        });
        expect((await ownerSocket.next('CHANNEL_CREATE')).name).toBe('via-instancia-2');
        expect((await friendSocket.next('CHANNEL_CREATE')).name).toBe('via-instancia-2');
      } finally {
        await second.close();
      }
    });
  });
});
