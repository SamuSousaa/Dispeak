import {
  RpcError,
  VoiceCloseCode,
  VoiceErrorCode,
  type EventInput,
  type MediaKind,
  type ProducerSource,
  type TransportDirection,
  type voiceClientSide,
  type VoicePeer,
  type VoiceProducer,
} from '@frequencia/shared';
import type { types } from 'mediasoup';
import type { Config } from '../config';
import type { Logger } from '../logger';
import type { PooledWorker } from '../worker-pool';
import { AUDIO_LEVEL_OBSERVER, mediaCodecs, TRANSPORT_BITRATE } from './media-codecs';
import type { ConsumerAppData, Peer, ProducerAppData, TransportAppData } from './peer';

type ClientEvent = keyof (typeof voiceClientSide)['events'];

export interface RoomHooks {
  onPeerJoined?: (room: Room, peer: Peer) => void;
  onPeerLeft?: (room: Room, peer: Peer) => void;
  onPeerState?: (room: Room, peer: Peer) => void;
  onProducerAdded?: (room: Room, peer: Peer, producer: VoiceProducer) => void;
  onProducerRemoved?: (room: Room, peer: Peer, producer: VoiceProducer) => void;
  onClosed?: (room: Room) => void;
}

export interface RoomStats {
  id: string;
  worker: number;
  peers: Array<{
    id: string;
    userId: string;
    name: string;
    muted: boolean;
    deafened: boolean;
    transports: number;
    producers: Array<{
      id: string;
      kind: MediaKind;
      source: ProducerSource;
      paused: boolean;
      /** `simulcast` for screen shares published with several layers. */
      type: string;
      layers: number;
    }>;
    consumers: Array<{
      id: string;
      producerId: string;
      kind: MediaKind;
      source: ProducerSource;
      paused: boolean;
      /** Simulcast layer requested by the viewer and the one currently forwarded. */
      preferredSpatialLayer: number | null;
      currentSpatialLayer: number | null;
    }>;
  }>;
}

/** Which producer sources a peer may publish at the same time. */
const SOURCE_KIND: Record<ProducerSource, MediaKind> = {
  mic: 'audio',
  screen: 'video',
  'screen-audio': 'audio',
};

/**
 * A voice channel: one mediasoup Router, an AudioLevelObserver and the peers inside it.
 * All protocol rules live here; the signaling layer only maps RPC calls to these methods.
 */
export class Room {
  readonly peers = new Map<string, Peer>();
  private speaking: string[] = [];
  private closed = false;

  private constructor(
    readonly id: string,
    readonly pooledWorker: PooledWorker,
    readonly router: types.Router,
    private readonly audioLevelObserver: types.AudioLevelObserver,
    private readonly config: Config,
    private readonly log: Logger,
    private readonly hooks: RoomHooks,
  ) {
    audioLevelObserver.on('volumes', (volumes) => {
      this.setSpeaking(volumes.map(({ producer }) => (producer.appData as ProducerAppData).peerId));
    });
    audioLevelObserver.on('silence', () => this.setSpeaking([]));
  }

  static async create(
    id: string,
    pooledWorker: PooledWorker,
    config: Config,
    log: Logger,
    hooks: RoomHooks = {},
  ): Promise<Room> {
    const router = await pooledWorker.worker.createRouter({ mediaCodecs });
    pooledWorker.routers += 1;
    const audioLevelObserver = await router.createAudioLevelObserver(AUDIO_LEVEL_OBSERVER);
    log.info({ room: id, worker: pooledWorker.index }, 'room created');
    return new Room(id, pooledWorker, router, audioLevelObserver, config, log, hooks);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get rtpCapabilities(): types.RtpCapabilities {
    return this.router.rtpCapabilities;
  }

  // --- membership ---------------------------------------------------------------------------

  join(
    peer: Peer,
    options: { rtpCapabilities: types.RtpCapabilities; muted: boolean; deafened: boolean },
  ): { self: VoicePeer; peers: VoicePeer[] } {
    if (peer.joined) throw new RpcError(VoiceErrorCode.AlreadyJoined, 'already joined');
    if (this.closed) throw new RpcError(VoiceErrorCode.InvalidState, 'room is closed');

    // A user holds one session per channel: a newer connection replaces the older one.
    for (const other of [...this.peers.values()]) {
      if (other.userId === peer.userId)
        this.removePeer(other, VoiceCloseCode.Replaced, 'replaced', true);
    }
    if (this.peers.size >= this.config.maxPeersPerRoom) {
      throw new RpcError(VoiceErrorCode.RoomFull, 'the channel is full');
    }

    peer.rtpCapabilities = options.rtpCapabilities;
    peer.deafened = options.deafened;
    peer.muted = options.muted || options.deafened || !peer.claims.speak;
    peer.joined = true;

    const peers = [...this.peers.values()].map((other) => other.toInfo());
    this.broadcast('peer-joined', { peer: peer.toInfo() });
    this.peers.set(peer.id, peer);
    this.hooks.onPeerJoined?.(this, peer);
    this.log.info({ room: this.id, peer: peer.id, user: peer.userId }, 'peer joined');

    return { self: peer.toInfo(), peers };
  }

  /** Removes a peer and releases everything it owned. Closes the room when it gets empty. */
  removePeer(peer: Peer, code = 1000, reason = '', keepRoomOpen = false): void {
    const wasMember = this.peers.delete(peer.id);
    const producers = wasMember ? peer.toInfo().producers : [];
    peer.close(code, reason);
    if (!wasMember) return;

    this.broadcast('peer-left', { peerId: peer.id });
    for (const producer of producers) this.hooks.onProducerRemoved?.(this, peer, producer);
    this.hooks.onPeerLeft?.(this, peer);
    this.log.info({ room: this.id, peer: peer.id, user: peer.userId }, 'peer left');

    if (this.speaking.includes(peer.id)) {
      this.setSpeaking(this.speaking.filter((id) => id !== peer.id));
    }
    if (this.peers.size === 0 && !keepRoomOpen) this.close();
  }

  close(code: number = VoiceCloseCode.RoomClosed, reason = 'room closed'): void {
    if (this.closed) return;
    this.closed = true;
    for (const peer of [...this.peers.values()]) {
      this.peers.delete(peer.id);
      peer.close(code, reason);
      this.hooks.onPeerLeft?.(this, peer);
    }
    this.router.close();
    this.pooledWorker.routers -= 1;
    this.hooks.onClosed?.(this);
    this.log.info({ room: this.id }, 'room closed');
  }

  // --- transports ---------------------------------------------------------------------------

  async createTransport(peer: Peer, direction: TransportDirection) {
    this.assertJoined(peer);

    // One transport per direction: asking again replaces the previous one.
    for (const existing of [...peer.transports.values()]) {
      if (existing.appData.direction === direction) this.closeTransport(peer, existing);
    }

    const transport = await this.router.createWebRtcTransport<TransportAppData>({
      webRtcServer: this.pooledWorker.webRtcServer,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: TRANSPORT_BITRATE.initialAvailableOutgoing,
      appData: { peerId: peer.id, direction },
    });
    if (peer.closed || this.closed) {
      transport.close();
      throw new RpcError(VoiceErrorCode.InvalidState, 'peer left while creating the transport');
    }
    peer.transports.set(transport.id, transport);

    if (direction === 'send') {
      await transport.setMaxIncomingBitrate(TRANSPORT_BITRATE.maxIncoming).catch(() => undefined);
    }

    // Orphan protection: a transport that never finishes DTLS, or whose ICE stays
    // disconnected, is closed and the client is told to reconnect.
    const drop = (why: string) => {
      if (transport.closed) return;
      this.log.debug(
        { room: this.id, peer: peer.id, transport: transport.id, why },
        'dropping transport',
      );
      this.closeTransport(peer, transport);
      peer.rpc.notify('transport-closed', { transportId: transport.id });
    };
    const schedule = (ms: number, why: string) => {
      const timer = setTimeout(() => {
        peer.timers.delete(timer);
        drop(why);
      }, ms);
      peer.timers.add(timer);
      return timer;
    };

    let connectTimer: NodeJS.Timeout | undefined = schedule(
      this.config.timeouts.transportConnectMs,
      'dtls never connected',
    );
    let iceTimer: NodeJS.Timeout | undefined;
    const clear = (timer: NodeJS.Timeout | undefined) => {
      if (!timer) return;
      clearTimeout(timer);
      peer.timers.delete(timer);
    };

    transport.on('dtlsstatechange', (state) => {
      if (state === 'connected') {
        clear(connectTimer);
        connectTimer = undefined;
      } else if (state === 'failed' || state === 'closed') {
        drop(`dtls ${state}`);
      }
    });
    transport.on('icestatechange', (state) => {
      clear(iceTimer);
      iceTimer = undefined;
      if (state === 'disconnected') {
        iceTimer = schedule(this.config.timeouts.iceDisconnectMs, 'ice disconnected');
      }
    });
    transport.observer.on('close', () => {
      clear(connectTimer);
      clear(iceTimer);
    });

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates as unknown as Array<Record<string, unknown>>,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  async connectTransport(
    peer: Peer,
    transportId: string,
    dtlsParameters: types.DtlsParameters,
  ): Promise<void> {
    const transport = this.getTransport(peer, transportId);
    await this.guard(() => transport.connect({ dtlsParameters }));
  }

  async restartIce(peer: Peer, transportId: string): Promise<types.IceParameters> {
    const transport = this.getTransport(peer, transportId);
    return transport.restartIce();
  }

  // --- producers ----------------------------------------------------------------------------

  async produce(
    peer: Peer,
    options: {
      transportId: string;
      kind: MediaKind;
      rtpParameters: types.RtpParameters;
      source: ProducerSource;
    },
  ): Promise<string> {
    const transport = this.getTransport(peer, options.transportId);
    if (transport.appData.direction !== 'send') {
      throw new RpcError(VoiceErrorCode.InvalidState, 'not a send transport');
    }
    if (SOURCE_KIND[options.source] !== options.kind) {
      throw new RpcError(
        VoiceErrorCode.InvalidState,
        `source "${options.source}" is not ${options.kind}`,
      );
    }
    const allowed = options.source === 'mic' ? peer.claims.speak : peer.claims.stream;
    if (!allowed) throw new RpcError(VoiceErrorCode.Forbidden, 'missing permission');
    for (const existing of peer.producers.values()) {
      if (existing.appData.source === options.source) {
        throw new RpcError(VoiceErrorCode.LimitReached, `already producing "${options.source}"`);
      }
    }

    const producer = await this.guard(() =>
      transport.produce<ProducerAppData>({
        kind: options.kind,
        rtpParameters: options.rtpParameters,
        paused: options.source === 'mic' && peer.muted,
        appData: { peerId: peer.id, source: options.source },
      }),
    );
    if (transport.closed) throw new RpcError(VoiceErrorCode.InvalidState, 'transport closed');

    peer.producers.set(producer.id, producer);
    const info: VoiceProducer = { id: producer.id, kind: producer.kind, source: options.source };

    producer.observer.on('close', () => {
      if (!peer.producers.delete(producer.id)) return;
      if (!this.peers.has(peer.id)) return;
      this.broadcast('producer-removed', { peerId: peer.id, producerId: producer.id }, peer.id);
      this.hooks.onProducerRemoved?.(this, peer, info);
    });

    if (options.source === 'mic') {
      await this.audioLevelObserver.addProducer({ producerId: producer.id }).catch(() => undefined);
    }

    this.broadcast('producer-added', { peerId: peer.id, producer: info }, peer.id);
    this.hooks.onProducerAdded?.(this, peer, info);
    return producer.id;
  }

  closeProducer(peer: Peer, producerId: string): void {
    const producer = peer.producers.get(producerId);
    if (!producer) throw new RpcError(VoiceErrorCode.NotFound, 'unknown producer');
    producer.close();
  }

  // --- consumers ----------------------------------------------------------------------------

  async consume(peer: Peer, producerId: string) {
    this.assertJoined(peer);
    const owner = [...this.peers.values()].find((other) => other.producers.has(producerId));
    const producer = owner?.producers.get(producerId);
    if (!owner || !producer) throw new RpcError(VoiceErrorCode.NotFound, 'unknown producer');
    if (owner.id === peer.id) {
      throw new RpcError(VoiceErrorCode.CannotConsume, 'cannot consume your own producer');
    }
    for (const existing of peer.consumers.values()) {
      if (existing.producerId === producerId) {
        throw new RpcError(VoiceErrorCode.LimitReached, 'already consuming this producer');
      }
    }
    const transport = [...peer.transports.values()].find(
      (candidate) => candidate.appData.direction === 'recv',
    );
    if (!transport) throw new RpcError(VoiceErrorCode.InvalidState, 'no receive transport');
    if (
      !peer.rtpCapabilities ||
      !this.router.canConsume({ producerId, rtpCapabilities: peer.rtpCapabilities })
    ) {
      throw new RpcError(VoiceErrorCode.CannotConsume, 'incompatible capabilities');
    }

    // Consumers start paused and flow only after the client confirms it is ready.
    const consumer = await transport.consume<ConsumerAppData>({
      producerId,
      rtpCapabilities: peer.rtpCapabilities,
      paused: true,
      appData: { peerId: peer.id, source: producer.appData.source, wanted: false },
    });
    peer.consumers.set(consumer.id, consumer);

    consumer.observer.on('close', () => {
      if (!peer.consumers.delete(consumer.id)) return;
      if (!peer.closed) peer.rpc.notify('consumer-closed', { consumerId: consumer.id });
    });
    consumer.on('layerschange', (layers) => {
      if (peer.closed) return;
      peer.rpc.notify('consumer-layers', {
        consumerId: consumer.id,
        spatialLayer: layers?.spatialLayer ?? null,
      });
    });

    return {
      consumerId: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters as unknown as {
        codecs: Array<Record<string, unknown>>;
      },
    };
  }

  async resumeConsumer(peer: Peer, consumerId: string): Promise<void> {
    const consumer = this.getConsumer(peer, consumerId);
    consumer.appData.wanted = true;
    // Deafen holds every audio consumer paused on the server, saving the bandwidth too.
    if (peer.deafened && consumer.kind === 'audio') return;
    await consumer.resume();
  }

  async pauseConsumer(peer: Peer, consumerId: string): Promise<void> {
    const consumer = this.getConsumer(peer, consumerId);
    consumer.appData.wanted = false;
    await consumer.pause();
  }

  closeConsumer(peer: Peer, consumerId: string): void {
    const consumer = this.getConsumer(peer, consumerId);
    peer.consumers.delete(consumer.id);
    consumer.close();
  }

  async setConsumerLayers(peer: Peer, consumerId: string, spatialLayer: number): Promise<void> {
    const consumer = this.getConsumer(peer, consumerId);
    if (consumer.type !== 'simulcast') return;
    await consumer.setPreferredLayers({ spatialLayer });
  }

  // --- state --------------------------------------------------------------------------------

  async setState(peer: Peer, state: { muted: boolean; deafened: boolean }): Promise<void> {
    this.assertJoined(peer);
    const deafened = state.deafened;
    const muted = state.muted || deafened || !peer.claims.speak;
    if (peer.muted === muted && peer.deafened === deafened) return;
    peer.muted = muted;
    peer.deafened = deafened;

    for (const producer of peer.producers.values()) {
      if (producer.appData.source !== 'mic') continue;
      await (muted ? producer.pause() : producer.resume());
    }
    for (const consumer of peer.consumers.values()) {
      if (consumer.kind !== 'audio') continue;
      if (deafened) await consumer.pause();
      else if (consumer.appData.wanted) await consumer.resume();
    }

    this.broadcast('peer-state', { peerId: peer.id, muted, deafened });
    this.hooks.onPeerState?.(this, peer);
    if (muted && this.speaking.includes(peer.id)) {
      this.setSpeaking(this.speaking.filter((id) => id !== peer.id));
    }
  }

  // --- introspection ------------------------------------------------------------------------

  stats(): RoomStats {
    return {
      id: this.id,
      worker: this.pooledWorker.index,
      peers: [...this.peers.values()].map((peer) => ({
        id: peer.id,
        userId: peer.userId,
        name: peer.claims.name,
        muted: peer.muted,
        deafened: peer.deafened,
        transports: peer.transports.size,
        producers: [...peer.producers.values()].map((producer) => ({
          id: producer.id,
          kind: producer.kind,
          source: producer.appData.source,
          paused: producer.paused,
          type: producer.type,
          layers: producer.rtpParameters.encodings?.length ?? 1,
        })),
        consumers: [...peer.consumers.values()].map((consumer) => ({
          id: consumer.id,
          producerId: consumer.producerId,
          kind: consumer.kind,
          source: consumer.appData.source,
          paused: consumer.paused,
          preferredSpatialLayer: consumer.preferredLayers?.spatialLayer ?? null,
          currentSpatialLayer: consumer.currentLayers?.spatialLayer ?? null,
        })),
      })),
    };
  }

  // --- internals ----------------------------------------------------------------------------

  private broadcast<E extends ClientEvent>(
    event: E,
    data: EventInput<typeof voiceClientSide, E>,
    exceptPeerId?: string,
  ): void {
    for (const peer of this.peers.values()) {
      if (peer.id !== exceptPeerId) peer.rpc.notify(event, data);
    }
  }

  private setSpeaking(peerIds: string[]): void {
    const next = [...new Set(peerIds)].filter((id) => this.peers.has(id));
    if (next.length === this.speaking.length && next.every((id) => this.speaking.includes(id))) {
      return;
    }
    this.speaking = next;
    this.broadcast('speaking', { peerIds: next });
  }

  private closeTransport(peer: Peer, transport: types.WebRtcTransport<TransportAppData>): void {
    peer.transports.delete(transport.id);
    transport.close();
  }

  private assertJoined(peer: Peer): void {
    if (!peer.joined || peer.closed || !this.peers.has(peer.id)) {
      throw new RpcError(VoiceErrorCode.NotJoined, 'join the channel first');
    }
  }

  private getTransport(peer: Peer, transportId: string) {
    this.assertJoined(peer);
    const transport = peer.transports.get(transportId);
    if (!transport) throw new RpcError(VoiceErrorCode.NotFound, 'unknown transport');
    return transport;
  }

  private getConsumer(peer: Peer, consumerId: string) {
    this.assertJoined(peer);
    const consumer = peer.consumers.get(consumerId);
    if (!consumer) throw new RpcError(VoiceErrorCode.NotFound, 'unknown consumer');
    return consumer;
  }

  /** mediasoup rejects malformed client parameters with TypeError; report those as such. */
  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof TypeError) {
        throw new RpcError('invalid_payload', error.message);
      }
      if (
        error instanceof Error &&
        /already|invalid|unsupported|not supported/i.test(error.message)
      ) {
        throw new RpcError(VoiceErrorCode.InvalidState, error.message);
      }
      throw error;
    }
  }
}
