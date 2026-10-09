import {
  apiInternalSide,
  mediaInternalSide,
  RpcPeer,
  VoiceCloseCode,
  type EventData,
} from '@frequencia/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { INTERNAL_PATH } from '../src/signaling/internal-server';
import {
  createHarness,
  eventually,
  openTransport,
  opusRtpParameters,
  simulcastRtpParameters,
  type Harness,
} from './helpers/harness';

type VoiceStateEvent = EventData<typeof apiInternalSide, 'voice-state'>;

/** Plays the role of an API instance connected to the internal endpoint. */
async function connectApi(h: Harness, secret = h.config.sharedSecret) {
  const socket = new WebSocket(`ws://127.0.0.1:${h.server.port}${INTERNAL_PATH}`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const events: VoiceStateEvent[] = [];
  const rpc = new RpcPeer({
    local: apiInternalSide,
    remote: mediaInternalSide,
    send: (frame) => socket.send(frame),
    requestTimeoutMs: 3000,
  });
  rpc.on('voice-state', (event) => events.push(event));
  socket.on('message', (data) => rpc.receive(data.toString()));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return {
    rpc,
    events,
    close: () =>
      new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
        socket.close();
      }),
  };
}

describe('internal API link', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it('refuses connections without the shared secret', async () => {
    await expect(connectApi(h, 'wrong-secret-wrong-secret-wrong-secret')).rejects.toThrow(/401/);
    const anonymous = new WebSocket(`ws://127.0.0.1:${h.server.port}${INTERNAL_PATH}`);
    await expect(new Promise((_, reject) => anonymous.once('error', reject))).rejects.toThrow(
      /401/,
    );
    expect(h.server.internal.linkCount).toBe(0);
  });

  it('reports joins, state changes, streaming and leaves, in order', async () => {
    const api = await connectApi(h);
    const alice = await h.joinAs({ sub: 'user-alice', room: 'channel-1' });

    await alice.rpc.request('setState', { muted: true, deafened: false });
    const transportId = await openTransport(alice, 'send');
    const { producerId } = await alice.rpc.request('produce', {
      transportId,
      kind: 'video',
      source: 'screen',
      rtpParameters: simulcastRtpParameters(),
    });
    await alice.rpc.request('closeProducer', { producerId });
    await alice.rpc.request('leave', {});
    await alice.closed;

    await eventually(() => expect(api.events.at(-1)?.state).toBeNull());
    expect(api.events.map((event) => event.state)).toEqual([
      { muted: false, deafened: false, streaming: false },
      { muted: true, deafened: false, streaming: false },
      { muted: true, deafened: false, streaming: true },
      { muted: true, deafened: false, streaming: false },
      null,
    ]);
    for (const event of api.events) {
      expect(event).toMatchObject({
        roomId: 'channel-1',
        userId: 'user-alice',
        peerId: alice.selfId,
      });
    }
    // Event ids are unique, so several API instances can deduplicate them.
    expect(new Set(api.events.map((event) => event.eventId)).size).toBe(api.events.length);
  });

  it('does not report a microphone producer as streaming', async () => {
    const api = await connectApi(h);
    const alice = await h.joinAs();
    const transportId = await openTransport(alice, 'send');
    await alice.rpc.request('produce', {
      transportId,
      kind: 'audio',
      source: 'mic',
      rtpParameters: opusRtpParameters(),
    });
    await eventually(() => expect(api.events).toHaveLength(2));
    expect(api.events.every((event) => event.state?.streaming === false)).toBe(true);
  });

  it('delivers every event to every connected API instance', async () => {
    const first = await connectApi(h);
    const second = await connectApi(h);
    await h.joinAs();
    await eventually(() => {
      expect(first.events).toHaveLength(1);
      expect(second.events).toHaveLength(1);
    });
    expect(first.events[0]?.eventId).toBe(second.events[0]?.eventId);
  });

  it('answers a snapshot with everyone currently in voice', async () => {
    const alice = await h.joinAs({ sub: 'user-alice', room: 'channel-1' });
    const bob = await h.joinAs({ sub: 'user-bob', room: 'channel-2' }, { muted: true });
    const api = await connectApi(h);

    const snapshot = await api.rpc.request('snapshot', {});
    expect(snapshot.nodeId).toBe(h.server.internal.nodeId);
    expect(snapshot.peers).toEqual(
      expect.arrayContaining([
        {
          roomId: 'channel-1',
          userId: 'user-alice',
          peerId: alice.selfId,
          state: { muted: false, deafened: false, streaming: false },
        },
        {
          roomId: 'channel-2',
          userId: 'user-bob',
          peerId: bob.selfId,
          state: { muted: true, deafened: false, streaming: false },
        },
      ]),
    );
    expect(snapshot.peers).toHaveLength(2);
  });

  it('kicks a user out of a voice channel on request', async () => {
    const api = await connectApi(h);
    const alice = await h.joinAs({ sub: 'user-alice' });
    const bob = await h.joinAs({ sub: 'user-bob' });

    const result = await api.rpc.request('disconnectUser', { userId: 'user-alice' });
    expect(result).toEqual({ disconnected: 1 });
    await expect(alice.closed).resolves.toBe(VoiceCloseCode.Kicked);
    await expect(bob.next('peer-left')).resolves.toEqual({ peerId: alice.selfId });
    expect(h.server.rooms.stats().totals.peers).toBe(1);

    // Unknown users and other rooms are a no-op.
    expect(await api.rpc.request('disconnectUser', { userId: 'nobody' })).toEqual({
      disconnected: 0,
    });
    expect(
      await api.rpc.request('disconnectUser', { userId: 'user-bob', roomId: 'another-room' }),
    ).toEqual({ disconnected: 0 });
  });

  it('uses a distinct close code when permissions changed, so the client can rejoin', async () => {
    const api = await connectApi(h);
    const alice = await h.joinAs({ sub: 'user-alice' });
    await api.rpc.request('disconnectUser', { userId: 'user-alice', reason: 'permissions' });
    await expect(alice.closed).resolves.toBe(VoiceCloseCode.PermissionsChanged);
  });

  it('closes a room on request, disconnecting everyone and freeing its router', async () => {
    const api = await connectApi(h);
    const alice = await h.joinAs({ room: 'channel-1' });
    const bob = await h.joinAs({ room: 'channel-1' });

    await api.rpc.request('closeRoom', { roomId: 'channel-1' });
    await expect(alice.closed).resolves.toBe(VoiceCloseCode.RoomClosed);
    await expect(bob.closed).resolves.toBe(VoiceCloseCode.RoomClosed);
    expect(h.server.rooms.stats().totals).toMatchObject({ rooms: 0, peers: 0 });
    await eventually(() =>
      expect(api.events.filter((event) => event.state === null)).toHaveLength(2),
    );
  });

  it('exposes totals for metrics', async () => {
    const api = await connectApi(h);
    await h.joinAs();
    await h.joinAs();
    expect(await api.rpc.request('stats', {})).toEqual({
      rooms: 1,
      peers: 2,
      transports: 0,
      producers: 0,
      consumers: 0,
      connections: 2,
    });
  });
});
