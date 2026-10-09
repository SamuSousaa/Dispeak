import { Permissions as P, type Channel, type Guild } from '@frequencia/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type Account, type TestApp } from './helpers/app';
import { startFakeMedia, type FakeMedia } from './helpers/fake-media';
import { connectGateway, type GatewayClient } from './helpers/gateway';

async function eventually(assertion: () => void | Promise<void>, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

describe('voice state and media link', () => {
  let media: FakeMedia;
  let t: TestApp;
  const clients: GatewayClient[] = [];

  const online = async (account: Account, app: TestApp = t) => {
    const client = await connectGateway(app.wsUrl);
    clients.push(client);
    await client.identify(account.token);
    return client;
  };
  const appFor = (fake: FakeMedia) =>
    createTestApp({ MEDIA_INTERNAL_URL: fake.url, MEDIA_SHARED_SECRET: fake.secret });

  /** A guild with its owner, one extra member and the default voice channel. */
  async function scenario(app: TestApp = t) {
    const [owner, member] = await Promise.all([app.account('Dona'), app.account('Membro')]);
    const guild = await app.createGuild(owner);
    await app.join(guild, owner, member);
    const voice = guild.channels.find((channel) => channel.type === 'voice');
    if (!voice) throw new Error('default voice channel missing');
    return { owner, member, guild, voice };
  }
  const getGuild = async (account: Account, guildId: string, app: TestApp = t) =>
    (await app.request('GET', `/guilds/${guildId}`, { token: account.token })).json<Guild>();
  const tokenFor = (account: Account, channelId: string, app: TestApp = t) =>
    app.request('POST', `/channels/${channelId}/voice-token`, { token: account.token });

  beforeAll(async () => {
    media = await startFakeMedia();
    t = await appFor(media);
    await eventually(() => expect(media.links()).toBe(1));
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    media.calls.length = 0;
    media.peers = [];
    media.snapshotDelayMs = 0;
  });

  afterAll(async () => {
    await t.close();
    await media.close();
  });

  it('reports the link in the health endpoint', async () => {
    expect((await t.request('GET', '/health')).json()).toMatchObject({ media: true });
  });

  it('mirrors joins, state changes and leaves to the guild in real time', async () => {
    const { owner, member, guild, voice } = await scenario();
    const socket = await online(owner);

    media.emit(voice.id, member.user.id, {});
    expect(await socket.next('VOICE_STATE_UPDATE')).toEqual({
      guildId: guild.id,
      channelId: voice.id,
      userId: member.user.id,
      muted: false,
      deafened: false,
      streaming: false,
    });

    media.emit(voice.id, member.user.id, { muted: true, streaming: true });
    expect(await socket.next('VOICE_STATE_UPDATE')).toMatchObject({ muted: true, streaming: true });
    // Anyone loading the guild later sees who is in voice.
    expect((await getGuild(owner, guild.id)).voiceStates).toEqual([
      {
        guildId: guild.id,
        channelId: voice.id,
        userId: member.user.id,
        muted: true,
        deafened: false,
        streaming: true,
      },
    ]);

    media.emit(voice.id, member.user.id, null);
    expect(await socket.next('VOICE_STATE_UPDATE')).toMatchObject({
      userId: member.user.id,
      channelId: null,
    });
    expect((await getGuild(owner, guild.id)).voiceStates).toEqual([]);
  });

  it('ignores a late "left" from a session that was already replaced', async () => {
    const { owner, member, guild, voice } = await scenario();
    const socket = await online(owner);

    media.emit(voice.id, member.user.id, {}, { peerId: 'old-session' });
    await socket.next('VOICE_STATE_UPDATE');
    media.emit(voice.id, member.user.id, {}, { peerId: 'new-session' });
    await socket.next('VOICE_STATE_UPDATE');
    media.emit(voice.id, member.user.id, null, { peerId: 'old-session' });

    await socket.expectNone('VOICE_STATE_UPDATE');
    expect((await getGuild(owner, guild.id)).voiceStates).toHaveLength(1);
  });

  it('hides voice states of channels the member cannot see', async () => {
    const { owner, member, guild } = await scenario();
    const secret = (
      await t.request('POST', `/guilds/${guild.id}/channels`, {
        token: owner.token,
        body: { name: 'reservado', type: 'voice' },
      })
    ).json<Channel>();
    await t.request('PUT', `/channels/${secret.id}/overwrites/${guild.id}`, {
      token: owner.token,
      body: { targetType: 'role', allow: '0', deny: P.ViewChannel.toString() },
    });
    const ownerSocket = await online(owner);
    const memberSocket = await online(member);

    media.emit(secret.id, owner.user.id, {});
    await ownerSocket.next('VOICE_STATE_UPDATE');
    await memberSocket.expectNone('VOICE_STATE_UPDATE');
    expect((await getGuild(member, guild.id)).voiceStates).toEqual([]);
    expect((await getGuild(owner, guild.id)).voiceStates).toHaveLength(1);
  });

  it('ignores rooms that are not voice channels (lab rooms)', async () => {
    const { owner } = await scenario();
    const socket = await online(owner);
    media.emit('lab:geral', 'lab:someone', {});
    media.emit('00000000-0000-4000-8000-000000000000', owner.user.id, {});
    await socket.expectNone('VOICE_STATE_UPDATE');
  });

  it('rebuilds the mirror from a snapshot when the link reconnects', async () => {
    const { owner, member, guild, voice } = await scenario();
    const socket = await online(owner);
    media.emit(voice.id, member.user.id, {});
    await socket.next('VOICE_STATE_UPDATE');

    // The media service restarts: the member is gone, the owner is now connected.
    media.peers = [
      {
        roomId: voice.id,
        userId: owner.user.id,
        peerId: 'peer-owner',
        state: { muted: true, deafened: false, streaming: false },
      },
    ];
    media.dropLinks();

    expect(
      await socket.next('VOICE_STATE_UPDATE', (state) => state.userId === member.user.id),
    ).toMatchObject({ channelId: null });
    expect(
      await socket.next('VOICE_STATE_UPDATE', (state) => state.userId === owner.user.id),
    ).toMatchObject({ channelId: voice.id, muted: true });
    expect((await getGuild(owner, guild.id)).voiceStates.map((state) => state.userId)).toEqual([
      owner.user.id,
    ]);
  });

  it('keeps what changed after the snapshot was taken', async () => {
    const { owner, member, guild, voice } = await scenario();
    const socket = await online(owner);
    media.emit(voice.id, owner.user.id, {});
    await socket.next('VOICE_STATE_UPDATE');

    // The link reopens and the snapshot, which only knows the owner, takes a while to arrive.
    media.peers = [
      {
        roomId: voice.id,
        userId: owner.user.id,
        peerId: `peer-${owner.user.id}`,
        state: { muted: false, deafened: false, streaming: false },
      },
    ];
    media.snapshotDelayMs = 300;
    const snapshots = media.snapshots;
    media.dropLinks();
    await eventually(() => expect(media.snapshots).toBe(snapshots + 1));

    // Meanwhile the member joins and the owner leaves.
    media.emit(voice.id, member.user.id, {});
    media.emit(voice.id, owner.user.id, null);
    expect(
      await socket.next('VOICE_STATE_UPDATE', (state) => state.userId === member.user.id),
    ).toMatchObject({ channelId: voice.id });
    expect(
      await socket.next('VOICE_STATE_UPDATE', (state) => state.userId === owner.user.id),
    ).toMatchObject({ channelId: null });

    await socket.expectNone('VOICE_STATE_UPDATE', 500);
    expect((await getGuild(owner, guild.id)).voiceStates.map((state) => state.userId)).toEqual([
      member.user.id,
    ]);
  });

  it('processes each media event once even with several API instances', async () => {
    const second = await appFor(media);
    try {
      await eventually(() => expect(media.links()).toBe(2));
      const { owner, member, voice } = await scenario();
      const socket = await online(owner);

      media.emit(voice.id, member.user.id, {});
      await socket.next('VOICE_STATE_UPDATE');
      await socket.expectNone('VOICE_STATE_UPDATE', 400);
    } finally {
      await second.close();
      await eventually(() => expect(media.links()).toBe(1));
    }
  });

  describe('enforcement', () => {
    it('removes a kicked member from voice', async () => {
      const { owner, member, guild, voice } = await scenario();
      await tokenFor(member, voice.id);
      media.emit(voice.id, member.user.id, {});
      await eventually(async () =>
        expect((await getGuild(owner, guild.id)).voiceStates).toHaveLength(1),
      );

      await t.request('DELETE', `/guilds/${guild.id}/members/${member.user.id}`, {
        token: owner.token,
      });
      await eventually(() =>
        expect(media.calls).toContainEqual({
          method: 'disconnectUser',
          data: { userId: member.user.id, roomId: voice.id, reason: 'kicked' },
        }),
      );
    });

    it('removes a member who loses CONNECT while in the channel', async () => {
      const { owner, member, guild, voice } = await scenario();
      await tokenFor(member, voice.id);
      media.emit(voice.id, member.user.id, {});
      await eventually(async () =>
        expect((await getGuild(owner, guild.id)).voiceStates).toHaveLength(1),
      );

      await t.request('PUT', `/channels/${voice.id}/overwrites/${member.user.id}`, {
        token: owner.token,
        body: { targetType: 'member', allow: '0', deny: P.Connect.toString() },
      });
      await eventually(() =>
        expect(media.calls).toContainEqual({
          method: 'disconnectUser',
          data: { userId: member.user.id, roomId: voice.id, reason: 'kicked' },
        }),
      );
    });

    it('makes a member rejoin when their speak or stream rights change', async () => {
      const { owner, member, guild, voice } = await scenario();
      await tokenFor(member, voice.id);
      media.emit(voice.id, member.user.id, {});
      await eventually(async () =>
        expect((await getGuild(owner, guild.id)).voiceStates).toHaveLength(1),
      );

      // Unrelated permission changes leave the call alone.
      await t.createRole(owner, guild.id, 'Decorativo');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(media.calls).toEqual([]);

      await t.request('PUT', `/channels/${voice.id}/overwrites/${guild.id}`, {
        token: owner.token,
        body: { targetType: 'role', allow: '0', deny: P.Stream.toString() },
      });
      await eventually(() =>
        expect(media.calls).toContainEqual({
          method: 'disconnectUser',
          data: { userId: member.user.id, roomId: voice.id, reason: 'permissions' },
        }),
      );
      // The owner keeps every permission, so nothing happens to them.
      expect(media.calls.filter((call) => call.method === 'disconnectUser')).toHaveLength(1);
    });

    it('closes the room of a deleted voice channel and of a deleted guild', async () => {
      const { owner, guild, voice } = await scenario();
      media.emit(voice.id, owner.user.id, {});
      await eventually(async () =>
        expect((await getGuild(owner, guild.id)).voiceStates).toHaveLength(1),
      );

      await t.request('DELETE', `/channels/${voice.id}`, { token: owner.token });
      await eventually(() =>
        expect(media.calls).toContainEqual({ method: 'closeRoom', data: { roomId: voice.id } }),
      );
      expect(await t.app.ctx.voiceStates.listChannel(voice.id)).toEqual([]);

      const other = (
        await t.request('POST', `/guilds/${guild.id}/channels`, {
          token: owner.token,
          body: { name: 'outro', type: 'voice' },
        })
      ).json<Channel>();
      await t.request('DELETE', `/guilds/${guild.id}`, { token: owner.token });
      await eventually(() =>
        expect(media.calls).toContainEqual({ method: 'closeRoom', data: { roomId: other.id } }),
      );
    });
  });
});
