import { randomUUID } from 'node:crypto';
import type {
  ProducerSource,
  RpcPeer,
  TransportDirection,
  voiceClientSide,
  VoicePeer,
  voiceServerSide,
  VoiceTokenClaims,
} from '@frequencia/shared';
import type { types } from 'mediasoup';

export type TransportAppData = { peerId: string; direction: TransportDirection };
export type IngestAppData = { peerId: string };
export type ProducerAppData = { peerId: string; source: ProducerSource };
export type ConsumerAppData = {
  peerId: string;
  source: ProducerSource;
  /** The client asked for this consumer to flow (it may still be held paused by deafen). */
  wanted: boolean;
};

export type VoiceRpc = RpcPeer<typeof voiceServerSide, typeof voiceClientSide>;

/**
 * One participant session. A peer owns every mediasoup object created on its behalf, so
 * closing the peer is enough to release all of them.
 */
export class Peer {
  readonly id = randomUUID();
  readonly transports = new Map<string, types.WebRtcTransport<TransportAppData>>();
  /** Plain transports receiving a native capture, one per ingest. */
  readonly ingests = new Map<string, types.PlainTransport<IngestAppData>>();
  readonly producers = new Map<string, types.Producer<ProducerAppData>>();
  readonly consumers = new Map<string, types.Consumer<ConsumerAppData>>();
  readonly timers = new Set<NodeJS.Timeout>();

  joined = false;
  closed = false;
  muted = false;
  deafened = false;
  rtpCapabilities: types.RtpCapabilities | undefined;

  constructor(
    readonly claims: VoiceTokenClaims,
    readonly rpc: VoiceRpc,
    private readonly closeSocket: (code: number, reason: string) => void,
  ) {}

  get userId(): string {
    return this.claims.sub;
  }

  toInfo(): VoicePeer {
    return {
      id: this.id,
      userId: this.claims.sub,
      name: this.claims.name,
      muted: this.muted,
      deafened: this.deafened,
      producers: [...this.producers.values()].map((producer) => ({
        id: producer.id,
        kind: producer.kind,
        source: producer.appData.source,
      })),
    };
  }

  /** Closes every transport (and with them all producers and consumers) of this peer. */
  releaseMedia(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const transport of this.transports.values()) transport.close();
    this.transports.clear();
    for (const ingest of this.ingests.values()) ingest.close();
    this.ingests.clear();
    this.producers.clear();
    this.consumers.clear();
  }

  /** Releases media and closes the signaling socket. */
  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    this.releaseMedia();
    this.closeSocket(code, reason);
  }
}
