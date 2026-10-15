import { VoiceCloseCode, VoiceErrorCode } from '@frequencia/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createHarness,
  eventually,
  openTransport,
  opusRtpParameters,
  simulcastRtpParameters,
  sleep,
  type Harness,
} from './helpers/harness';

describe('voice signaling', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  describe('authentication', () => {
    it('closes sockets that present no valid token', async () => {
      const peer = await h.connect('garbage');
      await expect(peer.closed).resolves.toBe(VoiceCloseCode.Unauthorized);
    });

    it('rejects tokens signed with another secret or already expired', async () => {
      const forged = await h.connect(
        await h.token({}, { secret: 'another-secret-another-secret-another-secret' }),
      );
      await expect(forged.closed).resolves.toBe(VoiceCloseCode.Unauthorized);

      const expired = await h.connect(await h.token({}, { expiresIn: '-10s' }));
      await expect(expired.closed).resolves.toBe(VoiceCloseCode.Unauthorized);
    });

    it('requires joining before any media request', async () => {
      const peer = await h.connect(await h.token());
      await expect(
        peer.rpc.request('createTransport', { direction: 'send' }),
      ).rejects.toMatchObject({ code: VoiceErrorCode.NotJoined });
    });
  });

  describe('membership', () => {
    it('lists the peers already in the channel and announces newcomers', async () => {
      const alice = await h.joinAs({ name: 'Alice' });
      const bob = await h.connect(await h.token({ name: 'Bob' }));
      const { rtpCapabilities } = await bob.rpc.request('getRouterCapabilities', {});
      const joined = await bob.rpc.request('join', { rtpCapabilities });

      expect(joined.peers).toMatchObject([{ id: alice.selfId, name: 'Alice', producers: [] }]);
      const announced = await alice.next<{ peer: { id: string; name: string } }>('peer-joined');
      expect(announced.peer).toMatchObject({ id: joined.self.id, name: 'Bob' });
    });

    it('keeps channels isolated from each other', async () => {
      const alice = await h.joinAs({ room: 'room-a' });
      await h.joinAs({ room: 'room-b' });
      await sleep(50);
      expect(alice.events).toEqual([]);
      expect(h.server.rooms.stats().totals).toMatchObject({ rooms: 2, peers: 2 });
    });

    it('replaces the older session when the same user joins again', async () => {
      const first = await h.joinAs({ sub: 'user-x' });
      const witness = await h.joinAs();
      const second = await h.joinAs({ sub: 'user-x' });

      await expect(first.closed).resolves.toBe(VoiceCloseCode.Replaced);
      await expect(witness.next('peer-left')).resolves.toEqual({ peerId: first.selfId });
      expect(
        h.server.rooms
          .stats()
          .rooms[0]?.peers.map((peer) => peer.id)
          .sort(),
      ).toEqual([witness.selfId, second.selfId].sort());
    });

    it('enforces the channel capacity', async () => {
      await h.close();
      h = await createHarness({ maxPeers: 2 });
      await h.joinAs();
      await h.joinAs();
      const third = await h.connect(await h.token());
      const { rtpCapabilities } = await third.rpc.request('getRouterCapabilities', {});
      await expect(third.rpc.request('join', { rtpCapabilities })).rejects.toMatchObject({
        code: VoiceErrorCode.RoomFull,
      });
    });

    it('drops sockets that never join', async () => {
      await h.close();
      h = await createHarness({ timeouts: { joinMs: 80 } });
      const idle = await h.connect(await h.token());
      await idle.rpc.request('getRouterCapabilities', {});
      await expect(idle.closed).resolves.toBe(VoiceCloseCode.JoinTimeout);
      // The router created to answer the capabilities request is released as well.
      expect(h.server.rooms.stats().totals.rooms).toBe(0);
    });
  });

  describe('media', () => {
    it('forwards a microphone producer to the other peers on demand', async () => {
      const alice = await h.joinAs({ name: 'Alice' });
      const bob = await h.joinAs({ name: 'Bob' });

      const sendTransport = await openTransport(alice, 'send');
      const { producerId } = await alice.rpc.request('produce', {
        transportId: sendTransport,
        kind: 'audio',
        source: 'mic',
        rtpParameters: opusRtpParameters(),
      });

      await expect(bob.next('producer-added')).resolves.toEqual({
        peerId: alice.selfId,
        producer: { id: producerId, kind: 'audio', source: 'mic' },
      });

      await openTransport(bob, 'recv');
      const consumer = await bob.rpc.request('consume', { producerId });
      expect(consumer).toMatchObject({ producerId, kind: 'audio' });
      expect(consumer.rtpParameters.codecs[0]).toMatchObject({ mimeType: 'audio/opus' });

      // Consumers are created paused and only flow after an explicit resume.
      const bobStats = () =>
        h.server.rooms.stats().rooms[0]?.peers.find((p) => p.id === bob.selfId);
      expect(bobStats()?.consumers).toMatchObject([{ producerId, paused: true }]);
      await bob.rpc.request('resumeConsumer', { consumerId: consumer.consumerId });
      expect(bobStats()?.consumers).toMatchObject([{ producerId, paused: false }]);
    });

    it('negotiates Opus with in-band FEC and DTX', async () => {
      const alice = await h.joinAs();
      const opus = (alice.rtpCapabilities.codecs as Array<Record<string, unknown>>).find(
        (codec) => codec.mimeType === 'audio/opus',
      );
      expect(opus?.parameters).toMatchObject({ useinbandfec: 1, usedtx: 1 });
    });

    it('tells late joiners about existing producers', async () => {
      const alice = await h.joinAs();
      const sendTransport = await openTransport(alice, 'send');
      const { producerId } = await alice.rpc.request('produce', {
        transportId: sendTransport,
        kind: 'audio',
        source: 'mic',
        rtpParameters: opusRtpParameters(),
      });

      const bob = await h.connect(await h.token());
      const { rtpCapabilities } = await bob.rpc.request('getRouterCapabilities', {});
      const joined = await bob.rpc.request('join', { rtpCapabilities });
      expect(joined.peers[0]?.producers).toEqual([
        { id: producerId, kind: 'audio', source: 'mic' },
      ]);
    });

    it('refuses invalid produce and consume requests', async () => {
      const alice = await h.joinAs();
      const bob = await h.joinAs();
      const send = await openTransport(alice, 'send');
      const recv = await openTransport(alice, 'recv');
      const produce = (overrides: Record<string, unknown> = {}) =>
        alice.rpc.request('produce', {
          transportId: send,
          kind: 'audio',
          source: 'mic',
          rtpParameters: opusRtpParameters(),
          ...overrides,
        });

      await expect(produce({ transportId: recv })).rejects.toMatchObject({
        code: VoiceErrorCode.InvalidState,
      });
      await expect(produce({ kind: 'video' })).rejects.toMatchObject({
        code: VoiceErrorCode.InvalidState,
      });
      await expect(produce({ transportId: 'nope' })).rejects.toMatchObject({
        code: VoiceErrorCode.NotFound,
      });
      await expect(
        produce({ rtpParameters: { codecs: [{ mimeType: 'audio/unknown' }] } }),
      ).rejects.toMatchObject({ code: 'invalid_payload' });

      const { producerId } = await produce();
      await expect(produce()).rejects.toMatchObject({ code: VoiceErrorCode.LimitReached });
      await expect(alice.rpc.request('consume', { producerId })).rejects.toMatchObject({
        code: VoiceErrorCode.CannotConsume,
      });
      // Bob has no receive transport yet.
      await expect(bob.rpc.request('consume', { producerId })).rejects.toMatchObject({
        code: VoiceErrorCode.InvalidState,
      });
      await expect(bob.rpc.request('consume', { producerId: 'nope' })).rejects.toMatchObject({
        code: VoiceErrorCode.NotFound,
      });
    });

    it('does not let a peer without the speak permission publish audio', async () => {
      const listener = await h.joinAs({ speak: false });
      const send = await openTransport(listener, 'send');
      await expect(
        listener.rpc.request('produce', {
          transportId: send,
          kind: 'audio',
          source: 'mic',
          rtpParameters: opusRtpParameters(),
        }),
      ).rejects.toMatchObject({ code: VoiceErrorCode.Forbidden });
      // ...and it is shown as muted to everyone.
      expect(h.server.rooms.stats().rooms[0]?.peers[0]?.muted).toBe(true);
    });
  });

  describe('mute and deafen', () => {
    async function callInProgress() {
      const alice = await h.joinAs({ name: 'Alice' });
      const bob = await h.joinAs({ name: 'Bob' });
      const send = await openTransport(alice, 'send');
      const { producerId } = await alice.rpc.request('produce', {
        transportId: send,
        kind: 'audio',
        source: 'mic',
        rtpParameters: opusRtpParameters(),
      });
      await openTransport(bob, 'recv');
      const { consumerId } = await bob.rpc.request('consume', { producerId });
      await bob.rpc.request('resumeConsumer', { consumerId });
      const stats = (id: string) => {
        const peer = h.server.rooms.stats().rooms[0]?.peers.find((entry) => entry.id === id);
        if (!peer) throw new Error('peer not found in stats');
        return peer;
      };
      return { alice, bob, producerId, consumerId, stats };
    }

    it('pauses the producer on the server and syncs the state to everyone', async () => {
      const { alice, bob, stats } = await callInProgress();

      await alice.rpc.request('setState', { muted: true, deafened: false });
      expect(stats(alice.selfId).producers[0]?.paused).toBe(true);
      await expect(bob.next('peer-state')).resolves.toEqual({
        peerId: alice.selfId,
        muted: true,
        deafened: false,
      });

      await alice.rpc.request('setState', { muted: false, deafened: false });
      expect(stats(alice.selfId).producers[0]?.paused).toBe(false);
      await expect(bob.next('peer-state')).resolves.toMatchObject({ muted: false });
    });

    it('deafen pauses incoming audio, implies mute, and undeafen restores it', async () => {
      const { alice, bob, stats } = await callInProgress();

      await bob.rpc.request('setState', { muted: false, deafened: true });
      expect(stats(bob.selfId)).toMatchObject({ muted: true, deafened: true });
      expect(stats(bob.selfId).consumers[0]?.paused).toBe(true);
      await expect(alice.next('peer-state')).resolves.toEqual({
        peerId: bob.selfId,
        muted: true,
        deafened: true,
      });

      await bob.rpc.request('setState', { muted: false, deafened: false });
      expect(stats(bob.selfId).consumers[0]?.paused).toBe(false);
    });

    it('keeps new consumers paused while deafened', async () => {
      const alice = await h.joinAs();
      const bob = await h.joinAs({}, { deafened: true });
      const send = await openTransport(alice, 'send');
      const { producerId } = await alice.rpc.request('produce', {
        transportId: send,
        kind: 'audio',
        source: 'mic',
        rtpParameters: opusRtpParameters(),
      });
      await openTransport(bob, 'recv');
      const { consumerId } = await bob.rpc.request('consume', { producerId });
      await bob.rpc.request('resumeConsumer', { consumerId });

      const consumer = () =>
        h.server.rooms.stats().rooms[0]?.peers.find((peer) => peer.id === bob.selfId)?.consumers[0];
      expect(consumer()?.paused).toBe(true);
      await bob.rpc.request('setState', { muted: false, deafened: false });
      expect(consumer()?.paused).toBe(false);
    });

    it('starts the microphone producer paused when joining muted', async () => {
      const alice = await h.joinAs({}, { muted: true });
      const send = await openTransport(alice, 'send');
      await alice.rpc.request('produce', {
        transportId: send,
        kind: 'audio',
        source: 'mic',
        rtpParameters: opusRtpParameters(),
      });
      expect(h.server.rooms.stats().rooms[0]?.peers[0]?.producers[0]?.paused).toBe(true);
    });
  });

  describe('resource cleanup', () => {
    /** Asks the mediasoup worker itself what is still alive. */
    async function workerResources() {
      const [pooled] = h.server.pool.all;
      if (!pooled) throw new Error('no worker');
      const worker = await pooled.worker.dump();
      const webRtcServer = await pooled.webRtcServer.dump();
      return {
        routers: worker.routerIds.length,
        transports: webRtcServer.webRtcTransportIds.length,
        iceUsernameFragments: webRtcServer.localIceUsernameFragments.length,
        pooledRouters: pooled.routers,
      };
    }

    async function fullCall() {
      const alice = await h.joinAs();
      const bob = await h.joinAs();
      for (const [sender, receiver] of [
        [alice, bob],
        [bob, alice],
      ] as const) {
        const send = await openTransport(sender, 'send');
        const { producerId } = await sender.rpc.request('produce', {
          transportId: send,
          kind: 'audio',
          source: 'mic',
          rtpParameters: opusRtpParameters(),
        });
        await openTransport(receiver, 'recv');
        const { consumerId } = await receiver.rpc.request('consume', { producerId });
        await receiver.rpc.request('resumeConsumer', { consumerId });
      }
      return { alice, bob };
    }

    it('releases every server resource when the peers leave the channel', async () => {
      const { alice, bob } = await fullCall();
      expect(h.server.rooms.stats().totals).toEqual({
        rooms: 1,
        peers: 2,
        transports: 4,
        producers: 2,
        consumers: 2,
      });
      expect(await workerResources()).toMatchObject({
        routers: 1,
        transports: 4,
        pooledRouters: 1,
      });

      // First peer leaves: its transports are gone, the consumer fed by it is closed.
      await alice.rpc.request('leave', {});
      await expect(alice.closed).resolves.toBe(1000);
      await expect(bob.next('peer-left')).resolves.toEqual({ peerId: alice.selfId });
      await expect(bob.next('consumer-closed')).resolves.toBeDefined();
      expect(h.server.rooms.stats().totals).toEqual({
        rooms: 1,
        peers: 1,
        transports: 2,
        producers: 1,
        consumers: 0,
      });
      expect(await workerResources()).toMatchObject({ routers: 1, transports: 2 });

      // Last peer leaves: the router itself is released.
      await bob.rpc.request('leave', {});
      await bob.closed;
      expect(h.server.rooms.stats().totals).toEqual({
        rooms: 0,
        peers: 0,
        transports: 0,
        producers: 0,
        consumers: 0,
      });
      expect(await workerResources()).toEqual({
        routers: 0,
        transports: 0,
        iceUsernameFragments: 0,
        pooledRouters: 0,
      });
    });

    it('releases everything when connections drop without leaving', async () => {
      const { alice, bob } = await fullCall();

      alice.socket.terminate();
      await expect(bob.next('peer-left')).resolves.toEqual({ peerId: alice.selfId });
      bob.socket.terminate();

      await eventually(async () => {
        expect(h.server.rooms.stats().totals.rooms).toBe(0);
        expect(await workerResources()).toEqual({
          routers: 0,
          transports: 0,
          iceUsernameFragments: 0,
          pooledRouters: 0,
        });
      });
    });

    it('detects dead connections through the heartbeat', async () => {
      await h.close();
      h = await createHarness({ timeouts: { heartbeatMs: 40 } });
      const alice = await h.joinAs();
      const bob = await h.joinAs();

      // Simulate a vanished client: the socket stays open but stops answering pings.
      bob.socket.pong = () => undefined;
      bob.socket.removeAllListeners('ping');
      (
        bob.socket as unknown as { _receiver: { removeAllListeners(e: string): void } }
      )._receiver.removeAllListeners('ping');

      await expect(alice.next('peer-left')).resolves.toEqual({ peerId: bob.selfId });
      expect(h.server.rooms.stats().totals.peers).toBe(1);
    });

    it('closes transports whose DTLS handshake never completes and tells the client', async () => {
      await h.close();
      h = await createHarness({ timeouts: { transportConnectMs: 80 } });
      const alice = await h.joinAs();
      // The helper starts a handshake with made-up parameters, which can never finish.
      const orphan = await openTransport(alice, 'send');

      await expect(alice.next('transport-closed')).resolves.toEqual({ transportId: orphan });
      expect(h.server.rooms.stats().totals.transports).toBe(0);
      expect((await workerResources()).transports).toBe(0);
    });

    it('keeps a transport that was created but not used yet', async () => {
      // Alone in a channel there is nothing to receive, so the receiving transport stays idle.
      await h.close();
      h = await createHarness({ timeouts: { transportConnectMs: 80 } });
      const alice = await h.joinAs();
      await alice.rpc.request('createTransport', { direction: 'recv' });

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(h.server.rooms.stats().totals.transports).toBe(1);
      expect(h.server.rooms.stats().totals.peers).toBe(1);
    });

    it('replaces a transport when the same direction is requested again', async () => {
      const alice = await h.joinAs();
      const first = await openTransport(alice, 'send');
      await alice.rpc.request('produce', {
        transportId: first,
        kind: 'audio',
        source: 'mic',
        rtpParameters: opusRtpParameters(),
      });
      const second = await openTransport(alice, 'send');

      expect(second).not.toBe(first);
      expect(h.server.rooms.stats().totals).toMatchObject({ transports: 1, producers: 0 });
      expect((await workerResources()).transports).toBe(1);
    });

    it('tells whoever shares a screen who is watching it', async () => {
      const alice = await h.joinAs({ name: 'Alice' });
      const bob = await h.joinAs({ name: 'Bob' });
      const carla = await h.joinAs({ name: 'Carla' });
      const { producerId } = await alice.rpc.request('produce', {
        transportId: await openTransport(alice, 'send'),
        kind: 'video',
        source: 'screen',
        rtpParameters: simulcastRtpParameters(),
      });

      // Having the consumer is not watching yet: it starts paused.
      await openTransport(bob, 'recv');
      const bobView = await bob.rpc.request('consume', { producerId });
      await bob.rpc.request('resumeConsumer', { consumerId: bobView.consumerId });
      await expect(alice.next('stream-viewers')).resolves.toEqual({ peerIds: [bob.selfId] });

      await openTransport(carla, 'recv');
      const carlaView = await carla.rpc.request('consume', { producerId });
      await carla.rpc.request('resumeConsumer', { consumerId: carlaView.consumerId });
      await expect(alice.next('stream-viewers')).resolves.toEqual({
        peerIds: [bob.selfId, carla.selfId].sort(),
      });

      // Off screen for a moment (window minimised): nothing is sent, and Bob still counts.
      await bob.rpc.request('pauseConsumer', { consumerId: bobView.consumerId, hidden: true });
      const bobConsumer = h.server.rooms
        .stats()
        .rooms[0]?.peers.find((peer) => peer.id === bob.selfId)
        ?.consumers.find((consumer) => consumer.id === bobView.consumerId);
      expect(bobConsumer?.paused).toBe(true);
      await bob.rpc.request('resumeConsumer', { consumerId: bobView.consumerId });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(alice.events.some((entry) => entry.event === 'stream-viewers')).toBe(false);
      // A plain pause means he stopped watching.
      await bob.rpc.request('pauseConsumer', { consumerId: bobView.consumerId });
      await expect(alice.next('stream-viewers')).resolves.toEqual({ peerIds: [carla.selfId] });
      await bob.rpc.request('resumeConsumer', { consumerId: bobView.consumerId });
      await expect(alice.next('stream-viewers')).resolves.toEqual({
        peerIds: [bob.selfId, carla.selfId].sort(),
      });

      // One stops watching, the other drops out of the call.
      await bob.rpc.request('closeConsumer', { consumerId: bobView.consumerId });
      await expect(alice.next('stream-viewers')).resolves.toEqual({ peerIds: [carla.selfId] });
      carla.socket.close();
      await expect(alice.next('stream-viewers')).resolves.toEqual({ peerIds: [] });
    });

    it('closes a producer on request and notifies its consumers', async () => {
      const { alice, bob } = await fullCall();
      const producerId = h.server.rooms
        .stats()
        .rooms[0]?.peers.find((peer) => peer.id === alice.selfId)?.producers[0]?.id;
      if (!producerId) throw new Error('producer not found');

      await alice.rpc.request('closeProducer', { producerId });
      await expect(bob.next('producer-removed')).resolves.toEqual({
        peerId: alice.selfId,
        producerId,
      });
      await expect(bob.next('consumer-closed')).resolves.toBeDefined();
      expect(h.server.rooms.stats().totals).toMatchObject({ producers: 1, consumers: 1 });
    });
  });
});

describe('worker balancing', () => {
  it('spreads channels across workers and frees the slot when a channel empties', async () => {
    const h = await createHarness({ workers: 2 });
    try {
      const a = await h.joinAs({ room: 'room-a' });
      await h.joinAs({ room: 'room-b' });
      const workers = h.server.rooms.stats().rooms.map((room) => room.worker);
      expect(new Set(workers).size).toBe(2);

      await a.rpc.request('leave', {});
      await a.closed;
      // The freed worker is the least loaded one again.
      await h.joinAs({ room: 'room-c' });
      expect(h.server.rooms.stats().workers.map((worker) => worker.routers)).toEqual([1, 1]);
    } finally {
      await h.close();
    }
  });
});
