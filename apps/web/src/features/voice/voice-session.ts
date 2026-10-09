import {
  MEDIA_PREFIX,
  RpcError,
  VOICE_SIGNALING_PATH,
  VoiceCloseCode,
  VoiceErrorCode,
  voiceClientSide,
  voiceServerSide,
  type ProducerSource,
  type TransportDirection,
  type VoicePeer,
  type VoiceTokenResponse,
} from '@frequencia/shared';
import { Device, type types } from 'mediasoup-client';
import { connectRpc, type RpcConnection } from '../../lib/rpc-client';
import { collectConnectionStats, type StatsSample } from './voice-stats';
import { emptyVoiceStats, initialVoiceState, useVoiceStore } from './voice-store';

type Connection = RpcConnection<typeof voiceClientSide, typeof voiceServerSide>;

interface ActiveConsumer {
  consumer: types.Consumer;
  peerId: string;
  source: ProducerSource;
  audio?: HTMLAudioElement;
}

export interface VoiceSessionOptions {
  channelId: string;
  channelName: string;
  /** Fetches a fresh voice token; called on every (re)connection attempt. */
  getToken: () => Promise<VoiceTokenResponse>;
}

const set = useVoiceStore.setState;
const get = useVoiceStore.getState;

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 8000, 8000];
const ICE_RESTART_GRACE_MS = 4000;
const STATS_INTERVAL_MS = 2000;

/** Close codes after which reconnecting would be wrong. */
const FATAL_CLOSE: Record<number, string> = {
  [VoiceCloseCode.Replaced]: 'Você entrou neste canal em outra aba ou dispositivo.',
  [VoiceCloseCode.Kicked]: 'Você foi removido do canal.',
  [VoiceCloseCode.RoomClosed]: 'O canal foi encerrado.',
};

/**
 * One voice channel connection: signaling socket, mediasoup device and transports, the
 * microphone producer and one consumer per remote audio producer. It survives network drops
 * by rebuilding everything from scratch (the server replaces the previous session).
 */
export class VoiceSession {
  private connection: Connection | null = null;
  private device: Device | null = null;
  private sendTransport: types.Transport | null = null;
  private recvTransport: types.Transport | null = null;
  private iceServers: RTCIceServer[] = [];
  private micTrack: MediaStreamTrack | null = null;
  private micProducer: types.Producer | null = null;
  private readonly consumers = new Map<string, ActiveConsumer>();
  private readonly consuming = new Set<string>();
  private readonly iceTimers = new Map<string, number>();
  private statsTimer: number | null = null;
  private statsSample: StatsSample | null = null;
  private reconnectTimer: number | null = null;
  private attempt = 0;
  private generation = 0;
  private mutedBeforeDeafen = false;
  private disposed = false;

  constructor(private readonly options: VoiceSessionOptions) {}

  // --- lifecycle ----------------------------------------------------------------------------

  async start(): Promise<void> {
    set({
      ...initialVoiceState,
      status: 'connecting',
      channelId: this.options.channelId,
      channelName: this.options.channelName,
    });
    await this.acquireMicrophone();
    await this.connect();
  }

  /** Leaves the channel and releases every local resource. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.connection?.rpc.request('leave', {}).catch(() => undefined);
    this.teardownConnection();
    this.micTrack?.stop();
    this.micTrack = null;
    set(initialVoiceState);
  }

  // --- user actions -------------------------------------------------------------------------

  async toggleMute(): Promise<void> {
    const { muted, deafened } = get();
    if (deafened) {
      // Unmuting while deafened makes no sense: undeafen and unmute together.
      await this.applyState(false, false);
      return;
    }
    if (muted && !this.micTrack) {
      await this.acquireMicrophone();
      if (!this.micTrack) return;
      await this.publishMicrophone();
    }
    await this.applyState(!muted, false);
  }

  async toggleDeafen(): Promise<void> {
    const { muted, deafened } = get();
    if (deafened) {
      await this.applyState(this.mutedBeforeDeafen, false);
    } else {
      this.mutedBeforeDeafen = muted;
      await this.applyState(true, true);
    }
  }

  // --- connection ---------------------------------------------------------------------------

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    const stale = () => this.disposed || generation !== this.generation;

    try {
      const { token, iceServers } = await this.options.getToken();
      if (stale()) return;
      this.iceServers = iceServers;

      const connection = await connectRpc({
        path: `${MEDIA_PREFIX}${VOICE_SIGNALING_PATH}?token=${encodeURIComponent(token)}`,
        local: voiceClientSide,
        remote: voiceServerSide,
        onClose: (event) => this.handleSocketClose(event, generation),
      });
      if (stale()) {
        connection.close();
        return;
      }
      this.connection = connection;
      const { rpc } = connection;
      this.bindEvents(connection);

      const { rtpCapabilities } = await rpc.request('getRouterCapabilities', {});
      const device = new Device();
      await device.load({ routerRtpCapabilities: rtpCapabilities as types.RtpCapabilities });
      this.device = device;

      const { muted, deafened } = get();
      const joined = await rpc.request('join', {
        rtpCapabilities: device.rtpCapabilities,
        muted: muted || !this.micTrack,
        deafened,
      });
      if (stale()) return;

      set({
        selfId: joined.self.id,
        muted: joined.self.muted,
        deafened: joined.self.deafened,
        peers: Object.fromEntries(joined.peers.map((peer) => [peer.id, peer])),
        speaking: [],
      });

      this.recvTransport = await this.createTransport('recv');
      this.sendTransport = await this.createTransport('send');
      if (stale()) return;

      await Promise.all([
        this.publishMicrophone(),
        ...joined.peers.flatMap((peer) =>
          peer.producers
            .filter((producer) => producer.source === 'mic')
            .map((producer) => this.consume(peer.id, producer.id, producer.source)),
        ),
      ]);
      if (stale()) return;

      this.attempt = 0;
      this.startStats();
      set({ status: 'connected', error: null });
    } catch (error) {
      if (stale()) return;
      console.warn('[voice] connection attempt failed', error);
      if (error instanceof RpcError && error.code === VoiceErrorCode.RoomFull) {
        this.fail('O canal está cheio.');
        return;
      }
      this.scheduleReconnect();
    }
  }

  private handleSocketClose(event: CloseEvent, generation: number): void {
    if (this.disposed || generation !== this.generation) return;
    const fatal = FATAL_CLOSE[event.code];
    if (fatal) {
      this.fail(fatal);
      return;
    }
    this.scheduleReconnect();
  }

  /** Drops the current connection (if any) and tries again with backoff. */
  private scheduleReconnect(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.teardownConnection();

    const delay = RECONNECT_DELAYS_MS[this.attempt];
    if (delay === undefined) {
      this.fail('Não foi possível conectar ao servidor de mídia.');
      return;
    }
    this.attempt += 1;
    set({ status: get().selfId ? 'reconnecting' : 'connecting', peers: {}, speaking: [] });
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private fail(message: string): void {
    this.generation += 1;
    this.teardownConnection();
    this.micTrack?.stop();
    this.micTrack = null;
    this.disposed = true;
    set({ ...initialVoiceState, status: 'error', error: message });
  }

  private teardownConnection(): void {
    if (this.statsTimer !== null) window.clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.statsSample = null;
    for (const timer of this.iceTimers.values()) window.clearTimeout(timer);
    this.iceTimers.clear();

    for (const consumerId of [...this.consumers.keys()]) this.removeConsumer(consumerId);
    this.consuming.clear();
    this.micProducer = null;
    this.sendTransport?.close();
    this.recvTransport?.close();
    this.sendTransport = null;
    this.recvTransport = null;
    this.device = null;
    this.connection?.close();
    this.connection = null;
    set({ stats: emptyVoiceStats });
  }

  private bindEvents({ rpc }: Connection): void {
    rpc.on('peer-joined', ({ peer }) => {
      set({ peers: { ...get().peers, [peer.id]: peer } });
    });

    rpc.on('peer-left', ({ peerId }) => {
      const { [peerId]: _gone, ...peers } = get().peers;
      set({ peers, speaking: get().speaking.filter((id) => id !== peerId) });
      for (const [consumerId, entry] of this.consumers) {
        if (entry.peerId === peerId) this.removeConsumer(consumerId);
      }
    });

    rpc.on('peer-state', ({ peerId, muted, deafened }) => {
      if (peerId === get().selfId) {
        set({ muted, deafened });
        return;
      }
      this.updatePeer(peerId, (peer) => ({ ...peer, muted, deafened }));
    });

    rpc.on('producer-added', ({ peerId, producer }) => {
      this.updatePeer(peerId, (peer) => ({ ...peer, producers: [...peer.producers, producer] }));
      if (producer.source === 'mic') void this.consume(peerId, producer.id, producer.source);
    });

    rpc.on('producer-removed', ({ peerId, producerId }) => {
      this.updatePeer(peerId, (peer) => ({
        ...peer,
        producers: peer.producers.filter((producer) => producer.id !== producerId),
      }));
      for (const [consumerId, entry] of this.consumers) {
        if (entry.consumer.producerId === producerId) this.removeConsumer(consumerId);
      }
    });

    rpc.on('speaking', ({ peerIds }) => set({ speaking: peerIds }));
    rpc.on('consumer-closed', ({ consumerId }) => this.removeConsumer(consumerId));
    rpc.on('transport-closed', () => this.scheduleReconnect());
  }

  private updatePeer(peerId: string, update: (peer: VoicePeer) => VoicePeer): void {
    const peer = get().peers[peerId];
    if (peer) set({ peers: { ...get().peers, [peerId]: update(peer) } });
  }

  // --- transports ---------------------------------------------------------------------------

  private async createTransport(direction: TransportDirection): Promise<types.Transport> {
    const { connection, device } = this;
    if (!connection || !device) throw new Error('not connected');
    const { rpc } = connection;

    const options = await rpc.request('createTransport', { direction });
    const transportOptions = {
      id: options.id,
      iceParameters: options.iceParameters as types.IceParameters,
      iceCandidates: options.iceCandidates as unknown as types.IceCandidate[],
      dtlsParameters: options.dtlsParameters as types.DtlsParameters,
      iceServers: this.iceServers,
    };
    const transport =
      direction === 'send'
        ? device.createSendTransport(transportOptions)
        : device.createRecvTransport(transportOptions);

    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      rpc
        .request('connectTransport', { transportId: transport.id, dtlsParameters })
        .then(() => callback(), errback);
    });

    if (direction === 'send') {
      transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
        rpc
          .request('produce', {
            transportId: transport.id,
            kind,
            rtpParameters,
            source: appData.source as ProducerSource,
          })
          .then(({ producerId }) => callback({ id: producerId }), errback);
      });
    }

    transport.on('connectionstatechange', (state) => {
      const pending = this.iceTimers.get(transport.id);
      if (pending !== undefined) window.clearTimeout(pending);
      this.iceTimers.delete(transport.id);

      if (state === 'failed') {
        void this.restartIce(transport);
      } else if (state === 'disconnected') {
        // Brief network blips usually recover on their own; restart ICE if they do not.
        this.iceTimers.set(
          transport.id,
          window.setTimeout(() => void this.restartIce(transport), ICE_RESTART_GRACE_MS),
        );
      }
    });

    return transport;
  }

  private async restartIce(transport: types.Transport): Promise<void> {
    if (transport.closed || !this.connection) return;
    try {
      const { iceParameters } = await this.connection.rpc.request('restartIce', {
        transportId: transport.id,
      });
      await transport.restartIce({ iceParameters: iceParameters as types.IceParameters });
    } catch (error) {
      console.warn('[voice] ICE restart failed, reconnecting', error);
      this.scheduleReconnect();
    }
  }

  // --- microphone ---------------------------------------------------------------------------

  private async acquireMicrophone(): Promise<void> {
    if (this.micTrack?.readyState === 'live') return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const [track] = stream.getAudioTracks();
      this.micTrack = track ?? null;
      set({ micAvailable: Boolean(track) });
    } catch (error) {
      console.warn('[voice] microphone unavailable, joining listen-only', error);
      this.micTrack = null;
      set({ micAvailable: false, muted: true });
    }
  }

  private async publishMicrophone(): Promise<void> {
    if (!this.sendTransport || !this.micTrack || this.micProducer) return;
    try {
      const producer = await this.sendTransport.produce({
        track: this.micTrack,
        // The session owns the track: it must survive reconnections.
        stopTracks: false,
        codecOptions: { opusDtx: true, opusFec: true, opusStereo: false },
        appData: { source: 'mic' satisfies ProducerSource },
      });
      this.micProducer = producer;
      if (get().muted) producer.pause();
      producer.on('transportclose', () => {
        if (this.micProducer === producer) this.micProducer = null;
      });
    } catch (error) {
      if (error instanceof RpcError && error.code === VoiceErrorCode.Forbidden) {
        set({ muted: true, micAvailable: false });
        return;
      }
      throw error;
    }
  }

  private async applyState(muted: boolean, deafened: boolean): Promise<void> {
    const effectiveMuted = muted || deafened || !this.micTrack;
    // Apply locally first so the microphone stops immediately, then sync the server.
    if (effectiveMuted) this.micProducer?.pause();
    else this.micProducer?.resume();
    for (const { audio } of this.consumers.values()) {
      if (audio) audio.muted = deafened;
    }
    set({ muted: effectiveMuted, deafened });
    await this.connection?.rpc
      .request('setState', { muted: effectiveMuted, deafened })
      .catch((error: unknown) => console.warn('[voice] failed to sync state', error));
  }

  // --- consumers ----------------------------------------------------------------------------

  private async consume(peerId: string, producerId: string, source: ProducerSource): Promise<void> {
    const { connection, recvTransport } = this;
    if (!connection || !recvTransport || this.consuming.has(producerId)) return;
    this.consuming.add(producerId);

    try {
      const response = await connection.rpc.request('consume', { producerId });
      const consumer = await recvTransport.consume({
        id: response.consumerId,
        producerId: response.producerId,
        kind: response.kind,
        rtpParameters: response.rtpParameters as unknown as types.RtpParameters,
      });
      if (recvTransport.closed) return;

      const entry: ActiveConsumer = { consumer, peerId, source };
      if (consumer.kind === 'audio') {
        const audio = new Audio();
        audio.srcObject = new MediaStream([consumer.track]);
        audio.muted = get().deafened;
        audio.play().catch((error: unknown) => console.warn('[voice] playback blocked', error));
        entry.audio = audio;
      }
      this.consumers.set(consumer.id, entry);
      await connection.rpc.request('resumeConsumer', { consumerId: consumer.id });
    } catch (error) {
      // The producer may be gone by the time we ask for it; that is not an error.
      if (!(error instanceof RpcError && error.code === VoiceErrorCode.NotFound)) {
        console.warn('[voice] failed to consume', error);
      }
    } finally {
      this.consuming.delete(producerId);
    }
  }

  private removeConsumer(consumerId: string): void {
    const entry = this.consumers.get(consumerId);
    if (!entry) return;
    this.consumers.delete(consumerId);
    if (entry.audio) {
      entry.audio.pause();
      entry.audio.srcObject = null;
    }
    entry.consumer.close();
  }

  // --- stats --------------------------------------------------------------------------------

  private startStats(): void {
    if (this.statsTimer !== null) window.clearInterval(this.statsTimer);
    this.statsTimer = window.setInterval(async () => {
      const { sendTransport, recvTransport } = this;
      if (!sendTransport || !recvTransport || sendTransport.closed || recvTransport.closed) return;
      try {
        const [sent, received] = await Promise.all([
          sendTransport.getStats(),
          recvTransport.getStats(),
        ]);
        const { stats, sample } = collectConnectionStats(sent, received, this.statsSample);
        this.statsSample = sample;
        set({ stats });
      } catch {
        // Transports can close between the check and the call.
      }
    }, STATS_INTERVAL_MS);
  }
}
