import { VoiceErrorCode } from '@frequencia/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createHarness,
  openTransport,
  simulcastRtpParameters,
  type Harness,
} from './helpers/harness';

type Joined = Awaited<ReturnType<Harness['joinAs']>>;

describe('native capture ingest', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  const peerStats = (peer: Joined) => {
    const stats = h.server.rooms.stats().rooms[0]?.peers.find((entry) => entry.id === peer.selfId);
    if (!stats) throw new Error('peer not found in stats');
    return stats;
  };

  /** Transports the mediasoup router really holds, whatever the bookkeeping says. */
  const routerTransports = async () => {
    const [room] = [...h.server.rooms.all];
    return room ? (await room.router.dump()).transportIds.length : 0;
  };

  it.each(['av1', 'h264'] as const)('publishes the screen in %s', async (codec) => {
    const alice = await h.joinAs();
    const bob = await h.joinAs();
    const ingest = await alice.rpc.request('createIngest', { codec });

    expect(ingest).toMatchObject({
      address: '127.0.0.1',
      payloadType: 96,
      srtp: { cryptoSuite: 'AES_CM_128_HMAC_SHA1_80' },
    });
    // Ports the WebRtcServer does not hold, inside the configured range.
    for (const port of [ingest.rtpPort, ingest.rtcpPort]) {
      expect(port).toBeGreaterThan(h.config.rtc.minPort);
      expect(port).toBeLessThanOrEqual(h.config.rtc.maxPort);
    }
    expect(ingest.rtcpPort).not.toBe(ingest.rtpPort);
    expect(Buffer.from(ingest.srtp.keyBase64, 'base64')).toHaveLength(30);

    expect(peerStats(alice)).toMatchObject({
      transports: 1,
      producers: [
        {
          id: ingest.producerId,
          kind: 'video',
          source: 'screen',
          paused: false,
          type: 'simple',
          layers: 1,
        },
      ],
    });
    await expect(bob.next('producer-added')).resolves.toEqual({
      peerId: alice.selfId,
      producer: { id: ingest.producerId, kind: 'video', source: 'screen' },
    });

    // A browser watches it like any other screen share.
    await openTransport(bob, 'recv');
    const consumer = await bob.rpc.request('consume', { producerId: ingest.producerId });
    expect(consumer.kind).toBe('video');
  });

  it('requires the stream permission', async () => {
    const viewer = await h.joinAs({ stream: false });
    await expect(viewer.rpc.request('createIngest', { codec: 'av1' })).rejects.toMatchObject({
      code: VoiceErrorCode.Forbidden,
    });
    expect(await routerTransports()).toBe(0);
  });

  it('is the one screen share of its peer', async () => {
    const alice = await h.joinAs();
    await alice.rpc.request('createIngest', { codec: 'av1' });

    await expect(alice.rpc.request('createIngest', { codec: 'h264' })).rejects.toMatchObject({
      code: VoiceErrorCode.LimitReached,
    });
    const transportId = await openTransport(alice, 'send');
    await expect(
      alice.rpc.request('produce', {
        transportId,
        kind: 'video',
        source: 'screen',
        rtpParameters: simulcastRtpParameters(),
      }),
    ).rejects.toMatchObject({ code: VoiceErrorCode.LimitReached });
    // The ingest and the browser's send transport, nothing left over from the refusals.
    expect(await routerTransports()).toBe(2);
  });

  it('keeps one of two ingests asked for at the same time', async () => {
    const alice = await h.joinAs();
    const results = await Promise.allSettled([
      alice.rpc.request('createIngest', { codec: 'av1' }),
      alice.rpc.request('createIngest', { codec: 'av1' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(peerStats(alice).producers).toHaveLength(1);
    expect(await routerTransports()).toBe(1);
  });

  it('releases the transport when the stream stops', async () => {
    const alice = await h.joinAs();
    const bob = await h.joinAs();
    const ingest = await alice.rpc.request('createIngest', { codec: 'av1' });
    await bob.next('producer-added');
    await openTransport(bob, 'recv');
    const { consumerId } = await bob.rpc.request('consume', { producerId: ingest.producerId });

    await alice.rpc.request('closeProducer', { producerId: ingest.producerId });
    await expect(bob.next('producer-removed')).resolves.toEqual({
      peerId: alice.selfId,
      producerId: ingest.producerId,
    });
    await expect(bob.next('consumer-closed')).resolves.toEqual({ consumerId });
    expect(peerStats(alice)).toMatchObject({ transports: 0, producers: [] });
    // Only the viewer's receive transport is left.
    expect(await routerTransports()).toBe(1);

    // The ports are free again: the same peer can start over.
    await expect(alice.rpc.request('createIngest', { codec: 'av1' })).resolves.toBeDefined();
  });

  it('releases the transport when its peer leaves', async () => {
    const alice = await h.joinAs();
    const bob = await h.joinAs();
    const ingest = await alice.rpc.request('createIngest', { codec: 'h264' });
    await bob.next('producer-added');

    await alice.close();
    await expect(bob.next('peer-left')).resolves.toEqual({ peerId: alice.selfId });
    expect(h.server.rooms.stats().totals).toMatchObject({ producers: 0, transports: 0 });
    expect(await routerTransports()).toBe(0);
    expect(ingest.producerId).toBeTruthy();
  });

  it('refuses a new ingest when the ports run out, and leaks nothing', async () => {
    // Ten ports per harness, one for the WebRtcServer: room for four ingests of two ports.
    const peers = await Promise.all([1, 2, 3, 4, 5].map(() => h.joinAs()));
    const [last, ...first] = peers.reverse();
    for (const peer of first) await peer.rpc.request('createIngest', { codec: 'av1' });

    await expect(
      (last as Joined).rpc.request('createIngest', { codec: 'av1' }),
    ).rejects.toMatchObject({ code: VoiceErrorCode.LimitReached });
    expect(await routerTransports()).toBe(4);
  });
});
