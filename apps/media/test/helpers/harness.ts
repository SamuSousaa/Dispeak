import {
  RpcPeer,
  VOICE_TOKEN_AUDIENCE,
  VOICE_TOKEN_ISSUER,
  voiceClientSide,
  voiceServerSide,
  type VoiceTokenClaims,
} from '@frequencia/shared';
import { SignJWT } from 'jose';
import WebSocket from 'ws';
import { loadConfig, type Config } from '../../src/config';
import { createLogger } from '../../src/logger';
import { startMediaServer, type MediaServer } from '../../src/server';
import { VOICE_PATH } from '../../src/signaling/voice-server';

type VoiceEvents = keyof (typeof voiceClientSide)['events'];

export interface TestPeer {
  rpc: RpcPeer<typeof voiceClientSide, typeof voiceServerSide>;
  socket: WebSocket;
  events: Array<{ event: VoiceEvents; data: unknown }>;
  /** Resolves with the next (or an already received, unread) occurrence of an event. */
  next: <T = Record<string, unknown>>(event: VoiceEvents) => Promise<T>;
  /** Resolves with the close code once the socket is closed. */
  closed: Promise<number>;
  close: () => Promise<void>;
}

export interface Harness {
  server: MediaServer;
  config: Config;
  token: (
    claims?: Partial<VoiceTokenClaims>,
    options?: { secret?: string; expiresIn?: string },
  ) => Promise<string>;
  connect: (token: string) => Promise<TestPeer>;
  /** Connects, fetches capabilities and joins in one go. */
  joinAs: (
    claims?: Partial<VoiceTokenClaims>,
    state?: { muted?: boolean; deafened?: boolean },
  ) => Promise<TestPeer & { selfId: string; rtpCapabilities: Record<string, unknown> }>;
  close: () => Promise<void>;
}

const PORTS_PER_HARNESS = 10;
/** Slots are reused once exhausted; by then the harnesses that held them are long closed. */
const HARNESSES_PER_POOL = 50;
let nextSlot = 0;
let nextUser = 1;

export async function createHarness(
  overrides: { workers?: number; maxPeers?: number; timeouts?: Partial<Config['timeouts']> } = {},
): Promise<Harness> {
  // Every harness gets its own RTC port block so test files can run in parallel workers. Each
  // Vitest worker owns a range wide enough that a file with many harnesses cannot spill into the
  // range of another worker.
  const poolId = Number(process.env.VITEST_POOL_ID ?? 0);
  const slot = nextSlot++ % HARNESSES_PER_POOL;
  const portBase = 42000 + (poolId * HARNESSES_PER_POOL + slot) * PORTS_PER_HARNESS;

  const config = loadConfig({
    NODE_ENV: 'test',
    MEDIA_HOST: '127.0.0.1',
    MEDIA_PORT: '0',
    MEDIA_NUM_WORKERS: String(overrides.workers ?? 1),
    MEDIA_MAX_PEERS_PER_ROOM: String(overrides.maxPeers ?? 50),
    MEDIA_SHARED_SECRET: 'test-secret-test-secret-test-secret-1234',
    RTC_ANNOUNCED_ADDRESSES: '127.0.0.1',
    RTC_MIN_PORT: String(portBase),
    RTC_MAX_PORT: String(portBase + PORTS_PER_HARNESS - 1),
  });
  Object.assign(config.timeouts, overrides.timeouts);

  const server = await startMediaServer(config, createLogger(config));
  const peers: TestPeer[] = [];

  const token: Harness['token'] = (claims = {}, options = {}) =>
    new SignJWT({
      name: 'Tester',
      room: 'room-1',
      speak: true,
      stream: true,
      ...claims,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub ?? `user-${nextUser++}`)
      .setAudience(VOICE_TOKEN_AUDIENCE)
      .setIssuer(VOICE_TOKEN_ISSUER)
      .setIssuedAt()
      .setExpirationTime(options.expiresIn ?? '1m')
      .sign(new TextEncoder().encode(options.secret ?? config.sharedSecret));

  const connect: Harness['connect'] = async (jwt) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}${VOICE_PATH}?token=${jwt}`);
    const events: TestPeer['events'] = [];
    const waiters = new Map<string, Array<(data: unknown) => void>>();
    const rpc = new RpcPeer({
      local: voiceClientSide,
      remote: voiceServerSide,
      send: (frame) => socket.send(frame),
      requestTimeoutMs: 3000,
    });

    for (const event of Object.keys(voiceClientSide.events) as VoiceEvents[]) {
      rpc.on(event, (data) => {
        const waiter = waiters.get(event)?.shift();
        if (waiter) waiter(data);
        else events.push({ event, data });
      });
    }
    socket.on('message', (data) => rpc.receive(data.toString()));

    const closed = new Promise<number>((resolve) => {
      socket.on('close', (code) => {
        rpc.close();
        resolve(code);
      });
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    const peer: TestPeer = {
      rpc,
      socket,
      events,
      closed,
      next: <T>(event: VoiceEvents) => {
        const index = events.findIndex((entry) => entry.event === event);
        if (index >= 0) return Promise.resolve(events.splice(index, 1)[0]?.data as T);
        return new Promise<T>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`timed out waiting for "${event}"`)),
            3000,
          );
          const list = waiters.get(event) ?? [];
          list.push((data) => {
            clearTimeout(timer);
            resolve(data as T);
          });
          waiters.set(event, list);
        });
      },
      close: async () => {
        if (socket.readyState !== WebSocket.CLOSED) socket.close();
        await closed;
      },
    };
    peers.push(peer);
    return peer;
  };

  const joinAs: Harness['joinAs'] = async (claims = {}, state = {}) => {
    const peer = await connect(await token(claims));
    const { rtpCapabilities } = await peer.rpc.request('getRouterCapabilities', {});
    const joined = await peer.rpc.request('join', {
      rtpCapabilities,
      muted: state.muted ?? false,
      deafened: state.deafened ?? false,
    });
    return Object.assign(peer, { selfId: joined.self.id, rtpCapabilities });
  };

  return {
    server,
    config,
    token,
    connect,
    joinAs,
    close: async () => {
      await Promise.all(peers.map((peer) => peer.close()));
      await server.close();
    },
  };
}

// --- synthetic WebRTC parameters ------------------------------------------------------------
// Enough for mediasoup to build producers and consumers without any media flowing.

export const fakeDtlsParameters = {
  role: 'client' as const,
  fingerprints: [
    {
      algorithm: 'sha-256',
      value:
        '82:5A:68:3D:36:C3:0A:DE:AF:E7:32:43:D2:88:83:57:AC:2D:65:E5:80:C4:B6:FB:AF:1A:A0:21:9F:6D:0C:AD',
    },
  ],
};

let nextSsrc = 1000;

export function opusRtpParameters() {
  return {
    mid: String(nextSsrc),
    codecs: [
      {
        mimeType: 'audio/opus',
        payloadType: 111,
        clockRate: 48000,
        channels: 2,
        parameters: { useinbandfec: 1, usedtx: 1 },
      },
    ],
    headerExtensions: [],
    encodings: [{ ssrc: nextSsrc++ }],
    rtcp: { cname: 'test' },
  };
}

export function vp8RtpParameters() {
  return {
    mid: String(nextSsrc),
    codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90000, parameters: {} }],
    headerExtensions: [],
    encodings: [{ ssrc: nextSsrc++ }],
    rtcp: { cname: 'test' },
  };
}

/** VP8 simulcast with three spatial layers, as browsers publish a screen share. */
export function simulcastRtpParameters() {
  const base = nextSsrc;
  nextSsrc += 3;
  return {
    mid: String(base),
    codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90000, parameters: {} }],
    headerExtensions: [],
    encodings: [{ ssrc: base }, { ssrc: base + 1 }, { ssrc: base + 2 }],
    rtcp: { cname: 'test' },
  };
}

/** Creates and "connects" a transport for a joined test peer. */
export async function openTransport(peer: TestPeer, direction: 'send' | 'recv'): Promise<string> {
  const transport = await peer.rpc.request('createTransport', { direction });
  await peer.rpc.request('connectTransport', {
    transportId: transport.id,
    dtlsParameters: fakeDtlsParameters,
  });
  return transport.id;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until the assertion stops throwing. */
export async function eventually(assertion: () => void | Promise<void>, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(20);
    }
  }
}
