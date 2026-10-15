import dgram from 'node:dgram';
import type { StreamViewerSample } from '@frequencia/shared';
import * as mediasoup from 'mediasoup';
import type { types } from 'mediasoup';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mediaCodecs } from '../src/rooms/media-codecs';
import type { StreamReportChunk } from '../src/rooms/stream-telemetry';
import { StreamTelemetry } from '../src/rooms/stream-telemetry';
import {
  createHarness,
  eventually,
  openTransport,
  simulcastRtpParameters,
  sleep,
  type Harness,
} from './helpers/harness';

const SSRC = 4242;
const PAYLOAD_TYPE = 96;

/** One VP8 RTP packet: a key frame starts with a payload whose lowest bit is clear. */
function vp8Packet(seq: number, timestamp: number, keyFrame: boolean, marker: boolean): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = (marker ? 0x80 : 0) | PAYLOAD_TYPE;
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(SSRC, 8);
  // Payload descriptor (start of partition 0), then the VP8 payload header.
  const payload = Buffer.alloc(200);
  payload[0] = 0x10;
  payload[1] = keyFrame ? 0x00 : 0x01;
  return Buffer.concat([header, payload]);
}

describe('stream telemetry, measured from the RTP packets', () => {
  let worker: types.Worker;
  let router: types.Router;
  let transport: types.PlainTransport;
  let producer: types.Producer;
  let socket: dgram.Socket;

  beforeAll(async () => {
    worker = await mediasoup.createWorker({ logLevel: 'error' });
    router = await worker.createRouter({ mediaCodecs });
  });

  afterAll(() => {
    worker.close();
  });

  beforeEach(async () => {
    transport = await router.createPlainTransport({
      listenInfo: { protocol: 'udp', ip: '127.0.0.1' },
      comedia: true,
      rtcpMux: true,
    });
    producer = await transport.produce({
      kind: 'video',
      rtpParameters: {
        codecs: [{ mimeType: 'video/VP8', payloadType: PAYLOAD_TYPE, clockRate: 90000 }],
        encodings: [{ ssrc: SSRC }],
      },
    });
    socket = dgram.createSocket('udp4');
  });

  afterEach(() => {
    socket.close();
    transport.close();
  });

  const send = (packet: Buffer) =>
    new Promise<void>((resolve, reject) =>
      socket.send(packet, transport.tuple.localPort, '127.0.0.1', (error) =>
        error ? reject(error) : resolve(),
      ),
    );

  it('counts whole frames, ignoring repeated and late packets', async () => {
    const chunks: StreamReportChunk[] = [];
    const telemetry = new StreamTelemetry(producer, 'native', (chunk) => chunks.push(chunk));

    let seq = 0;
    let timestamp = 1000;
    for (let frame = 0; frame < 20; frame += 1) {
      const keyFrame = frame === 0;
      // Three packets per frame, the first one sent twice, as a retransmission would arrive.
      const first = vp8Packet(seq++, timestamp, keyFrame, false);
      await send(first);
      await send(first);
      await send(vp8Packet(seq++, timestamp, keyFrame, false));
      await send(vp8Packet(seq++, timestamp, keyFrame, true));
      // A straggler of the frame before arrives after this one started.
      if (frame > 0) await send(vp8Packet(seq++, timestamp - 3000, false, false));
      timestamp += 3000;
      // One long stall in the middle.
      await sleep(frame === 10 ? 250 : 35);
    }
    await eventually(async () => {
      const [stats] = await producer.getStats();
      expect(stats?.packetCount ?? 0).toBeGreaterThanOrEqual(70);
    });
    telemetry.close();

    expect(chunks).toHaveLength(1);
    const [chunk] = chunks;
    expect(chunk).toMatchObject({ path: 'native', codec: 'VP8', producerId: producer.id });
    expect(chunk?.endedAt).toBeInstanceOf(Date);
    const [sample] = chunk?.samples ?? [];
    expect(sample?.sender).toBeNull();
    expect(sample?.viewers).toEqual([]);
    const server = sample?.server;
    // Repeated or late packets counted as frames would bring the gaps down to nothing.
    expect(server?.gapP50Ms).toBeGreaterThanOrEqual(25);
    expect(server?.gapP50Ms).toBeLessThan(80);
    expect(server?.gapMaxMs).toBeGreaterThanOrEqual(240);
    expect(server?.keyFrames).toBe(1);
    expect(server?.fps).toBeGreaterThan(5);
    expect(server?.kbps).toBeGreaterThan(0);
  });
});

describe('stream telemetry, as reported through the media service', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  const viewerSample: StreamViewerSample = {
    fps: 58,
    framesDropped: 2,
    freezes: 1,
    freezeMs: 120,
    decodeMs: 3.5,
    jitterBufferMs: 40,
    lossPercent: 0,
    width: 1920,
    height: 1080,
    kbps: 6000,
    decoder: 'D3D11VideoDecoder',
  };

  it('keeps what the streamer and its viewers say, and nothing from anyone else', async () => {
    const chunks: StreamReportChunk[] = [];
    const users: string[] = [];
    h.server.rooms.hooks.onStreamReport = (_room, peer, chunk) => {
      users.push(peer.userId);
      chunks.push(chunk);
    };
    const alice = await h.joinAs({ sub: 'alice' });
    const bruno = await h.joinAs({ sub: 'bruno' });
    const carla = await h.joinAs({ sub: 'carla' });

    const sendTransport = await openTransport(alice, 'send');
    const { producerId } = await alice.rpc.request('produce', {
      transportId: sendTransport,
      kind: 'video',
      source: 'screen',
      rtpParameters: simulcastRtpParameters(),
    });
    await openTransport(bruno, 'recv');
    await bruno.rpc.request('consume', { producerId });

    alice.rpc.notify('stream-stats', {
      role: 'sender',
      producerId,
      sample: {
        captureFps: 60,
        sentFps: 59,
        encodeMs: 6,
        width: 1920,
        height: 1080,
        kbps: 8000,
        limitation: null,
        encoder: 'MediaFoundationVideoEncodeAccelerator',
        preset: '1080p60',
      },
    });
    // Two reports of one viewer in a window: counters add up, rates average, the size is the
    // last one (an average of two sizes is no size at all, and the API refuses it).
    bruno.rpc.notify('stream-stats', {
      role: 'viewer',
      producerId,
      sample: { ...viewerSample, width: 1280, height: 720 },
    });
    bruno.rpc.notify('stream-stats', {
      role: 'viewer',
      producerId,
      sample: { ...viewerSample, fps: 54, freezes: 2, freezeMs: 300 },
    });
    // Not watching, and not the owner: ignored.
    carla.rpc.notify('stream-stats', { role: 'viewer', producerId, sample: viewerSample });
    bruno.rpc.notify('stream-stats', {
      role: 'sender',
      producerId,
      sample: {
        captureFps: 1,
        sentFps: 1,
        encodeMs: null,
        width: null,
        height: null,
        kbps: null,
        limitation: null,
        encoder: null,
        preset: null,
      },
    });
    // Let the notifications reach the server before the stream ends.
    await alice.rpc.request('getRouterCapabilities', {});
    await bruno.rpc.request('getRouterCapabilities', {});
    await carla.rpc.request('getRouterCapabilities', {});

    await alice.rpc.request('closeProducer', { producerId });
    await eventually(() => expect(chunks).toHaveLength(1));

    expect(users).toEqual(['alice']);
    const [sample] = chunks[0]?.samples ?? [];
    expect(chunks[0]).toMatchObject({ producerId, path: 'browser' });
    expect(sample?.sender).toMatchObject({ captureFps: 60, sentFps: 59, preset: '1080p60' });
    expect(sample?.viewers).toEqual([
      { ...viewerSample, userId: 'bruno', fps: 56, framesDropped: 4, freezes: 3, freezeMs: 420 },
    ]);
  });
});
