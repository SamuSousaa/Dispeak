import {
  MEDIA_PREFIX,
  RpcError,
  VOICE_SIGNALING_PATH,
  VoiceCloseCode,
  VoiceErrorCode,
  voiceClientSide,
  voiceServerSide,
  type DesktopNativeCaptureStats,
  type IngestCodec,
  type ProducerSource,
  type TransportDirection,
  type VoicePeer,
  type VoiceTokenResponse,
} from '@frequencia/shared';
import { Device, type types } from 'mediasoup-client';
import { connectRpc, type RpcConnection } from '../../lib/rpc-client';
import { desktop } from '../desktop/desktop';
import { useSettingsStore, type Settings } from '../settings/settings-store';
import { CAMERA, openCamera } from './camera';
import { startGameAudio, type GameAudio } from './game-audio';
import { createNativePreview, type NativePreview } from './native-preview';
import { meterTrack } from './level-meter';
import { openMicrophone, type Microphone } from './microphone';
import {
  layerForViewport,
  SCREEN_PRESETS,
  simulcastEncodings,
  type ScreenPresetId,
  type ScreenPreset,
} from './screen-presets';
import { pickScreenCodec } from './video-codec';
import {
  collectConnectionStats,
  collectInboundStreamStats,
  collectOutboundStreamStats,
  type StatsSample,
  type StreamSample,
} from './voice-stats';
import {
  cameraOff,
  emptyVoiceStats,
  initialVoiceState,
  screenOff,
  SELF_STREAM,
  useVoiceStore,
  type StreamStats,
  type WatchedStream,
} from './voice-store';

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

/**
 * Thrown by `getToken` when the user may not join the channel at all. Unlike a network
 * failure, this ends the session instead of retrying.
 */
export class VoiceAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceAccessError';
  }
}

const set = useVoiceStore.setState;
const get = useVoiceStore.getState;

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 8000, 8000];
const ICE_RESTART_GRACE_MS = 4000;
const STATS_INTERVAL_MS = 2000;
/** Opus target for a voice: well above what browsers choose on their own (about 32 kbps). */
const VOICE_BITRATE = 64_000;
const SCREEN_AUDIO_BITRATE = 256_000;

/**
 * Whether the captured sound includes what this page itself plays, that is, the voices of the
 * call: viewers would then hear themselves back through the stream. It happens when the whole
 * screen is shared with the sound of the system and the browser cannot leave its own out.
 */
function capturesOwnAudio(video: MediaStreamTrack, audio: MediaStreamTrack | undefined): boolean {
  if (!audio) return false;
  const surface = (video.getSettings() as { displaySurface?: string }).displaySurface;
  if (surface !== 'monitor') return false;
  const supported = (
    navigator.mediaDevices.getSupportedConstraints() as { restrictOwnAudio?: boolean }
  ).restrictOwnAudio;
  const applied = (audio.getSettings() as { restrictOwnAudio?: boolean }).restrictOwnAudio;
  return supported !== true || applied === false;
}

/** What the panel says goes out as the stream's sound. */
function audioSourceOf(gameAudio: GameAudio | null): string | null {
  if (!gameAudio) return null;
  return gameAudio.name ? `SÓ ${gameAudio.name}` : 'O PC, SEM CHAMADAS DE VOZ';
}

/** Close codes after which reconnecting would be wrong. */
const FATAL_CLOSE: Record<number, string> = {
  [VoiceCloseCode.Replaced]: 'Você entrou neste canal em outra aba ou dispositivo.',
  [VoiceCloseCode.Kicked]: 'Você foi removido do canal.',
  [VoiceCloseCode.RoomClosed]: 'O canal foi encerrado.',
};

const isScreenSource = (source: ProducerSource) => source === 'screen' || source === 'screen-audio';

/**
 * One voice channel connection: signaling socket, mediasoup device and transports, the
 * microphone and screen producers, and the consumers for remote audio and watched streams.
 * It survives network drops by rebuilding everything from scratch (the server replaces the
 * previous session), republishing whatever was live.
 */
export class VoiceSession {
  private connection: Connection | null = null;
  private device: Device | null = null;
  private sendTransport: types.Transport | null = null;
  private recvTransport: types.Transport | null = null;
  private iceServers: RTCIceServer[] = [];

  private microphone: Microphone | null = null;
  private micTrack: MediaStreamTrack | null = null;
  /** Serializes microphone swaps triggered by settings changes. */
  private micReload: Promise<void> = Promise.resolve();
  private unsubscribeSettings: (() => void) | null = null;
  private micProducer: types.Producer | null = null;
  private stopMeter: (() => void) | null = null;
  private screenStream: MediaStream | null = null;
  private screenProducer: types.Producer | null = null;
  private screenAudioProducer: types.Producer | null = null;
  /** Set while the desktop app itself captures the screen, not this page: the codec it sends. */
  private nativeShare: IngestCodec | null = null;
  private nativeProducerId: string | null = null;
  /** The system's audio that goes with a native share, captured by the browser. */
  private nativeAudio: { track: MediaStreamTrack; echoRisk: boolean } | null = null;
  private unsubscribeNative: (() => void) | null = null;
  private unsubscribeNativeStats: (() => void) | null = null;
  /** The capture engine's latest numbers, while it sends (app 0.11 and later). */
  private nativeStats: DesktopNativeCaptureStats | null = null;
  /** The streamer's own picture of a native capture, and what feeds it. */
  private nativePreview: NativePreview | null = null;
  private unsubscribePreview: (() => void) | null = null;
  /** Why the capture engine could not run, when the share fell back to ffmpeg. */
  private engineProblem: string | null = null;
  /** The sound of the shared program alone (desktop app), in place of the system's. */
  private gameAudio: GameAudio | null = null;
  private cameraStream: MediaStream | null = null;
  private cameraProducer: types.Producer | null = null;

  private readonly consumers = new Map<string, ActiveConsumer>();
  private readonly consuming = new Set<string>();
  /** Streamers this client chose to watch. */
  private readonly watched = new Set<string>();
  /** Simulcast layer wanted for each watched stream, from the size it is displayed at. */
  private readonly wantedLayers = new Map<string, number>();
  /** Same, for each participant's camera. */
  private readonly cameraLayers = new Map<string, number>();

  private readonly iceTimers = new Map<string, number>();
  private statsTimer: number | null = null;
  private statsSample: StatsSample | null = null;
  private readonly streamSamples = new Map<string, StreamSample>();
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
    this.unsubscribeSettings = useSettingsStore.subscribe((settings, previous) =>
      this.handleSettingsChange(settings, previous),
    );
    await this.acquireMicrophone();
    if (this.disposed) return;
    await this.connect();
  }

  /** Leaves the channel and releases every local resource. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.connection?.rpc.request('leave', {}).catch(() => undefined);
    this.teardownConnection();
    this.releaseLocalMedia();
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

  /** Push-to-talk key pressed or released. */
  setPushToTalk(held: boolean): void {
    if (get().pttHeld === held) return;
    set({ pttHeld: held });
    this.gateMicrophone();
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

  async startScreenShare(presetId: ScreenPresetId): Promise<void> {
    if (get().screen.status !== 'off' || get().status !== 'connected') return;
    const preset = SCREEN_PRESETS[presetId];
    set({ screen: { ...screenOff, status: 'starting', preset: presetId } });
    if (await this.startNativeShare()) return;

    // Dismissing the picker is not an error worth showing. The browser's own picker reports
    // it as `NotAllowedError`, the desktop app's as `AbortError`.
    const wasCancelled = (error: unknown) =>
      error instanceof DOMException &&
      (error.name === 'NotAllowedError' || error.name === 'AbortError');

    let stream: MediaStream;
    try {
      stream = await this.captureDisplay(preset, true);
    } catch (error) {
      if (wasCancelled(error)) {
        set({ screen: screenOff });
        return;
      }
      // The audio source can fail on its own (busy device, unsupported surface): a stream
      // without sound is better than no stream, and the UI says that it has no audio.
      console.warn('[voice] screen capture with audio failed, retrying without it', error);
      try {
        stream = await this.captureDisplay(preset, false);
      } catch (retryError) {
        if (!wasCancelled(retryError)) console.warn('[voice] screen capture failed', retryError);
        set({
          screen: {
            ...screenOff,
            error: wasCancelled(retryError)
              ? null
              : 'Não foi possível capturar a tela neste navegador.',
          },
        });
        return;
      }
    }

    const [videoTrack] = stream.getVideoTracks();
    if (!videoTrack) {
      for (const track of stream.getTracks()) track.stop();
      set({ screen: { ...screenOff, error: 'A captura não retornou vídeo.' } });
      return;
    }
    videoTrack.contentHint = preset.contentHint;
    // The browser's own "stop sharing" button ends the track.
    videoTrack.addEventListener('ended', () => void this.stopScreenShare());
    this.screenStream = stream;

    const gameAudio = await startGameAudio();
    if (this.screenStream !== stream) {
      gameAudio?.stop();
      return;
    }
    if (gameAudio) {
      this.gameAudio = gameAudio;
      for (const track of stream.getAudioTracks()) {
        track.stop();
        stream.removeTrack(track);
      }
    }

    try {
      await this.publishScreen();
    } catch (error) {
      console.warn('[voice] failed to publish the screen', error);
      const forbidden = error instanceof RpcError && error.code === VoiceErrorCode.Forbidden;
      await this.stopScreenShare();
      set({
        screen: {
          ...screenOff,
          error: forbidden
            ? 'Você não tem permissão para transmitir neste canal.'
            : 'Falha ao iniciar a transmissão.',
        },
      });
    }
  }

  /** Asks the browser (or the app's picker) for the screen, with the system's audio or without. */
  private captureDisplay(preset: ScreenPreset, withAudio: boolean): Promise<MediaStream> {
    return navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: preset.width, max: preset.width },
        height: { ideal: preset.height, max: preset.height },
        // Asked for exactly 60, the browser's screen capturer delivers about 57 (measured on
        // a 180 Hz display); given headroom it holds 60, its own ceiling. The encoder caps
        // the stream at the preset's rate either way.
        frameRate: {
          ideal: preset.frameRate,
          max: preset.frameRate >= 60 ? preset.frameRate * 1.5 : preset.frameRate,
        },
      },
      // System/tab audio is only offered by some browsers and capture surfaces.
      ...(withAudio
        ? {
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
              // Keeps the call itself out of the captured system audio. Without it the
              // viewers get their own voices back through the stream. Browsers that do
              // not know the option ignore it.
              restrictOwnAudio: true,
            },
            systemAudio: 'include',
          }
        : {}),
    } as DisplayMediaStreamOptions);
  }

  async stopScreenShare(): Promise<void> {
    if (this.nativeShare) {
      const producerId = this.nativeProducerId;
      this.nativeShare = null;
      this.nativeProducerId = null;
      this.nativeStats = null;
      this.stopNativePreview();
      this.nativeAudio?.track.stop();
      this.nativeAudio = null;
      await desktop?.nativeCapture?.stop().catch(() => undefined);
      if (producerId) {
        await this.connection?.rpc.request('closeProducer', { producerId }).catch(() => undefined);
      }
    }
    const producers = [this.screenProducer, this.screenAudioProducer];
    this.screenProducer = null;
    this.screenAudioProducer = null;
    for (const producer of producers) {
      if (!producer || producer.closed) continue;
      producer.close();
      await this.connection?.rpc
        .request('closeProducer', { producerId: producer.id })
        .catch(() => undefined);
    }
    for (const track of this.screenStream?.getTracks() ?? []) track.stop();
    this.screenStream = null;
    this.gameAudio?.stop();
    this.gameAudio = null;
    this.streamSamples.delete(SELF_STREAM);
    const { [SELF_STREAM]: _self, ...streamStats } = get().streamStats;
    set({ screen: screenOff, streamStats, screenViewers: [] });
  }

  async startCamera(): Promise<void> {
    if (get().camera.status !== 'off' || get().status !== 'connected') return;
    set({ camera: { ...cameraOff, status: 'starting' } });

    let stream: MediaStream;
    try {
      stream = await openCamera(useSettingsStore.getState().cameraDeviceId);
    } catch (error) {
      console.warn('[voice] camera unavailable', error);
      const denied = error instanceof DOMException && error.name === 'NotAllowedError';
      set({
        camera: {
          ...cameraOff,
          error: denied
            ? 'Permita o uso da câmera no navegador.'
            : 'Não foi possível abrir a câmera.',
        },
      });
      return;
    }
    if (this.disposed) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    // Unplugging the camera ends the track.
    stream.getVideoTracks()[0]?.addEventListener('ended', () => void this.stopCamera());
    this.cameraStream = stream;

    try {
      await this.publishCamera();
    } catch (error) {
      console.warn('[voice] failed to publish the camera', error);
      const forbidden = error instanceof RpcError && error.code === VoiceErrorCode.Forbidden;
      await this.stopCamera();
      set({
        camera: {
          ...cameraOff,
          error: forbidden
            ? 'Você não tem permissão para ligar a câmera neste canal.'
            : 'Falha ao ligar a câmera.',
        },
      });
    }
  }

  async stopCamera(): Promise<void> {
    const producer = this.cameraProducer;
    this.cameraProducer = null;
    if (producer && !producer.closed) {
      producer.close();
      await this.connection?.rpc
        .request('closeProducer', { producerId: producer.id })
        .catch(() => undefined);
    }
    for (const track of this.cameraStream?.getTracks() ?? []) track.stop();
    this.cameraStream = null;
    set({ camera: cameraOff });
  }

  /** Reports the size a participant's camera is displayed at, to pick its simulcast layer. */
  setCameraViewport(peerId: string, cssHeight: number): void {
    const layer = layerForViewport(cssHeight, window.devicePixelRatio);
    if (this.cameraLayers.get(peerId) === layer) return;
    this.cameraLayers.set(peerId, layer);
    for (const [consumerId, entry] of this.consumers) {
      if (entry.peerId === peerId && entry.source === 'camera') {
        this.connection?.rpc
          .request('setConsumerLayers', { consumerId, spatialLayer: layer })
          .catch(() => undefined);
      }
    }
  }

  /** Starts receiving a participant's screen share (video and, when present, its audio). */
  watch(peerId: string): void {
    const peer = get().peers[peerId];
    if (!peer || this.watched.has(peerId)) return;
    this.watched.add(peerId);
    this.setWatching(peerId, { stream: null, spatialLayer: null });
    for (const producer of peer.producers) {
      if (isScreenSource(producer.source)) void this.consume(peerId, producer.id, producer.source);
    }
  }

  /** Stops receiving a stream: its consumers are closed on the server as well. */
  unwatch(peerId: string): void {
    if (!this.watched.delete(peerId)) return;
    this.wantedLayers.delete(peerId);
    for (const [consumerId, entry] of this.consumers) {
      if (entry.peerId !== peerId || !isScreenSource(entry.source)) continue;
      this.connection?.rpc.request('closeConsumer', { consumerId }).catch(() => undefined);
      this.removeConsumer(consumerId);
    }
    this.forgetStream(peerId);
  }

  /** Reports the size a watched stream is displayed at, to pick its simulcast layer. */
  /** How loud this user hears the sound of one stream; nobody else is affected. */
  setStreamVolume(peerId: string, volume: number): void {
    set({ streamVolumes: { ...get().streamVolumes, [peerId]: Math.min(1, Math.max(0, volume)) } });
    for (const entry of this.consumers.values()) {
      if (entry.peerId === peerId && entry.source === 'screen-audio') this.applyVolume(entry);
    }
  }

  setStreamViewport(peerId: string, cssHeight: number): void {
    if (!this.watched.has(peerId)) return;
    const layer = layerForViewport(cssHeight, window.devicePixelRatio);
    if (this.wantedLayers.get(peerId) === layer) return;
    this.wantedLayers.set(peerId, layer);
    for (const [consumerId, entry] of this.consumers) {
      if (entry.peerId === peerId && entry.source === 'screen') {
        this.connection?.rpc
          .request('setConsumerLayers', { consumerId, spatialLayer: layer })
          .catch(() => undefined);
      }
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

      // Streams watched before a reconnection are resumed if their streamer is still live.
      for (const peerId of [...this.watched]) {
        const stillLive = joined.peers
          .find((peer) => peer.id === peerId)
          ?.producers.some((producer) => producer.source === 'screen');
        if (!stillLive) {
          this.watched.delete(peerId);
          this.forgetStream(peerId);
        }
      }

      await Promise.all([
        this.publishMicrophone(),
        this.screenStream ? this.publishScreen().catch(() => this.stopScreenShare()) : undefined,
        // The ingest of the previous connection went with it: ask for a new one.
        this.nativeShare
          ? this.publishNative().then(
              (live) => (live ? undefined : this.stopScreenShare()),
              () => this.stopScreenShare(),
            )
          : undefined,
        this.cameraStream ? this.publishCamera().catch(() => this.stopCamera()) : undefined,
        ...joined.peers.flatMap((peer) =>
          peer.producers
            .filter(
              (producer) =>
                producer.source === 'mic' ||
                producer.source === 'camera' ||
                (this.watched.has(peer.id) && isScreenSource(producer.source)),
            )
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
      if (error instanceof VoiceAccessError) {
        this.fail(error.message);
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
    this.releaseLocalMedia();
    this.disposed = true;
    set({ ...initialVoiceState, status: 'error', error: message });
  }

  /** Closes everything tied to the current socket. Local capture tracks stay alive. */
  private teardownConnection(): void {
    if (this.statsTimer !== null) window.clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.statsSample = null;
    this.streamSamples.clear();
    for (const timer of this.iceTimers.values()) window.clearTimeout(timer);
    this.iceTimers.clear();

    for (const consumerId of [...this.consumers.keys()]) this.removeConsumer(consumerId);
    this.consuming.clear();
    this.micProducer = null;
    this.screenProducer = null;
    this.screenAudioProducer = null;
    this.cameraProducer = null;
    this.sendTransport?.close();
    this.recvTransport?.close();
    this.sendTransport = null;
    this.recvTransport = null;
    this.device = null;
    this.connection?.close();
    this.connection = null;
    set({ stats: emptyVoiceStats, streamStats: {} });
  }

  private releaseLocalMedia(): void {
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    this.stopMeter?.();
    this.stopMeter = null;
    this.microphone?.close();
    this.microphone = null;
    this.micTrack = null;
    for (const track of this.screenStream?.getTracks() ?? []) track.stop();
    this.screenStream = null;
    if (this.nativeShare) void desktop?.nativeCapture?.stop().catch(() => undefined);
    this.nativeShare = null;
    this.nativeProducerId = null;
    this.nativeAudio?.track.stop();
    this.nativeAudio = null;
    this.unsubscribeNative?.();
    this.unsubscribeNative = null;
    this.unsubscribeNativeStats?.();
    this.unsubscribeNativeStats = null;
    this.nativeStats = null;
    this.stopNativePreview();
    this.gameAudio?.stop();
    this.gameAudio = null;
    for (const track of this.cameraStream?.getTracks() ?? []) track.stop();
    this.cameraStream = null;
    this.watched.clear();
    this.wantedLayers.clear();
    this.cameraLayers.clear();
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
      this.watched.delete(peerId);
      this.cameraLayers.delete(peerId);
      this.forgetStream(peerId);
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
      // Microphones and cameras are always received; screens only when the user asked to
      // watch them.
      if (!isScreenSource(producer.source) || this.watched.has(peerId)) {
        void this.consume(peerId, producer.id, producer.source);
      }
    });

    rpc.on('producer-removed', ({ peerId, producerId }) => {
      const removed = get().peers[peerId]?.producers.find((producer) => producer.id === producerId);
      this.updatePeer(peerId, (peer) => ({
        ...peer,
        producers: peer.producers.filter((producer) => producer.id !== producerId),
      }));
      for (const [consumerId, entry] of this.consumers) {
        if (entry.consumer.producerId === producerId) this.removeConsumer(consumerId);
      }
      if (removed?.source === 'screen') {
        this.watched.delete(peerId);
        this.forgetStream(peerId);
      }
    });

    rpc.on('speaking', ({ peerIds }) => set({ speaking: peerIds }));
    rpc.on('stream-viewers', ({ peerIds }) => set({ screenViewers: peerIds }));
    rpc.on('consumer-closed', ({ consumerId }) => this.removeConsumer(consumerId));
    rpc.on('consumer-layers', ({ consumerId, spatialLayer }) => {
      const entry = this.consumers.get(consumerId);
      const current = entry ? get().watching[entry.peerId] : undefined;
      if (entry && current) this.setWatching(entry.peerId, { ...current, spatialLayer });
    });
    rpc.on('transport-closed', () => this.scheduleReconnect());
  }

  private updatePeer(peerId: string, update: (peer: VoicePeer) => VoicePeer): void {
    const peer = get().peers[peerId];
    if (peer) set({ peers: { ...get().peers, [peerId]: update(peer) } });
  }

  private setWatching(peerId: string, value: WatchedStream): void {
    set({ watching: { ...get().watching, [peerId]: value } });
  }

  private forgetStream(peerId: string): void {
    this.wantedLayers.delete(peerId);
    this.streamSamples.delete(peerId);
    const { [peerId]: _watching, ...watching } = get().watching;
    const { [peerId]: _stats, ...streamStats } = get().streamStats;
    set({ watching, streamStats });
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
      const microphone = await openMicrophone(useSettingsStore.getState());
      if (this.disposed) {
        microphone.close();
        return;
      }
      this.microphone?.close();
      this.microphone = microphone;
      this.micTrack = microphone.track;
      this.watchLevel();
      set({ micAvailable: true, noiseSuppression: microphone.noiseSuppression });
    } catch (error) {
      console.warn('[voice] microphone unavailable, joining listen-only', error);
      this.microphone = null;
      this.micTrack = null;
      set({ micAvailable: false, muted: true, noiseSuppression: null });
    }
  }

  /** Follows the level of the track being sent, so the user can see their voice going out. */
  private watchLevel(): void {
    this.stopMeter?.();
    this.stopMeter = this.micTrack
      ? meterTrack(this.micTrack, (micLevel) => set({ micLevel }))
      : null;
  }

  private handleSettingsChange(settings: Settings, previous: Settings): void {
    if (settings.cameraDeviceId !== previous.cameraDeviceId && this.cameraStream) {
      void this.stopCamera().then(() => this.startCamera());
    }
    if (
      settings.userVolumes !== previous.userVolumes ||
      settings.outputVolume !== previous.outputVolume
    ) {
      for (const entry of this.consumers.values()) this.applyVolume(entry);
    }
    if (settings.inputMode !== previous.inputMode) this.gateMicrophone();
    if (settings.outputDeviceId !== previous.outputDeviceId) {
      for (const { audio } of this.consumers.values()) {
        if (audio) this.routeOutput(audio);
      }
    }
    if (
      settings.inputDeviceId !== previous.inputDeviceId ||
      settings.noiseSuppression !== previous.noiseSuppression ||
      settings.echoCancellation !== previous.echoCancellation ||
      settings.autoGainControl !== previous.autoGainControl ||
      settings.voiceLeveler !== previous.voiceLeveler ||
      settings.micGain !== previous.micGain
    ) {
      this.micReload = this.micReload.then(() => this.reloadMicrophone());
    }
  }

  /** Reopens the microphone with the current settings and swaps it into the live producer. */
  private async reloadMicrophone(): Promise<void> {
    if (this.disposed) return;
    let next: Microphone;
    try {
      next = await openMicrophone(useSettingsStore.getState());
    } catch (error) {
      // Keep whatever was working before.
      console.warn('[voice] could not reopen the microphone', error);
      return;
    }
    if (this.disposed) {
      next.close();
      return;
    }
    const previous = this.microphone;
    this.microphone = next;
    this.micTrack = next.track;
    this.watchLevel();
    set({ micAvailable: true, noiseSuppression: next.noiseSuppression });
    try {
      if (this.micProducer && !this.micProducer.closed) {
        await this.micProducer.replaceTrack({ track: next.track });
      } else {
        await this.publishMicrophone();
      }
    } catch (error) {
      console.warn('[voice] failed to switch the microphone', error);
    }
    previous?.close();
  }

  /**
   * Opens or closes the microphone: muted never sends; in push-to-talk mode it also needs the
   * key held. The key does not change the `muted` everyone else sees.
   */
  private gateMicrophone(): void {
    const { muted, pttHeld } = get();
    const open = !muted && (useSettingsStore.getState().inputMode !== 'pushToTalk' || pttHeld);
    if (open) this.micProducer?.resume();
    else this.micProducer?.pause();
  }

  /** How this user chose to hear a participant's voice, and the sound of each stream. */
  private applyVolume({ audio, peerId, source }: ActiveConsumer): void {
    if (!audio) return;
    const userId = get().peers[peerId]?.userId;
    const settings = useSettingsStore.getState();
    const own =
      source === 'screen-audio'
        ? (get().streamVolumes[peerId] ?? 1)
        : source === 'mic' && userId
          ? (settings.userVolumes[userId] ?? 1)
          : 1;
    // The person's or stream's own volume, under the master one of the quick audio menu.
    const volume = own * settings.outputVolume;
    // iPhones ignore `volume`; silencing someone still works there through `muted`.
    audio.volume = volume;
    audio.muted = get().deafened || volume === 0;
  }

  /** Sends remote audio to the output device chosen in the settings, where supported. */
  private routeOutput(audio: HTMLAudioElement): void {
    if (typeof audio.setSinkId !== 'function') return;
    const deviceId = useSettingsStore.getState().outputDeviceId ?? '';
    if (audio.sinkId === deviceId) return;
    audio.setSinkId(deviceId).catch((error: unknown) => {
      console.warn('[voice] could not switch the output device', error);
    });
  }

  private async publishMicrophone(): Promise<void> {
    if (!this.sendTransport || !this.micTrack || this.micProducer) return;
    try {
      const producer = await this.sendTransport.produce({
        track: this.micTrack,
        // The session owns the track: it must survive reconnections.
        stopTracks: false,
        // Twice the bitrate browsers pick for speech on their own, and no DTX: the voice
        // keeps its detail and the first syllable after a pause is not clipped.
        codecOptions: {
          opusDtx: false,
          opusFec: true,
          opusStereo: false,
          opusMaxAverageBitrate: VOICE_BITRATE,
          opusMaxPlaybackRate: 48_000,
        },
        appData: { source: 'mic' satisfies ProducerSource },
      });
      this.micProducer = producer;
      // After a server mute is lifted the same session is allowed to publish again.
      if (!get().micAvailable) set({ micAvailable: true });
      this.gateMicrophone();
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
    set({ muted: effectiveMuted, deafened });
    this.gateMicrophone();
    for (const entry of this.consumers.values()) this.applyVolume(entry);
    await this.connection?.rpc
      .request('setState', { muted: effectiveMuted, deafened })
      .catch((error: unknown) => console.warn('[voice] failed to sync state', error));
  }

  // --- screen share -------------------------------------------------------------------------

  /**
   * Publishes the captured screen with the encodings of its preset, in the codec this machine
   * handles best, plus its audio track when there is one.
   */
  private async publishScreen(): Promise<void> {
    const { sendTransport, device, screenStream } = this;
    const presetId = get().screen.preset;
    if (!sendTransport || !device || !screenStream || !presetId) return;
    const [videoTrack] = screenStream.getVideoTracks();
    const audioTrack = this.gameAudio?.track ?? screenStream.getAudioTracks()[0];
    if (!videoTrack || videoTrack.readyState !== 'live') throw new Error('screen track ended');

    const preset = SCREEN_PRESETS[presetId];
    const topBitrate = Math.max(...preset.bitrates);
    const codec = await pickScreenCodec(device.rtpCapabilities.codecs, {
      width: preset.width,
      height: preset.height,
      frameRate: preset.frameRate,
      bitrate: topBitrate,
    });
    // The share may have been stopped, or the call dropped, while the browser was asked.
    if (this.sendTransport !== sendTransport || this.screenStream !== screenStream) return;
    this.screenProducer = await sendTransport.produce({
      track: videoTrack,
      stopTracks: false,
      encodings: simulcastEncodings(preset),
      // Start near the target instead of climbing to it over the first seconds (kbps).
      codecOptions: { videoGoogleStartBitrate: Math.min(4000, Math.round(topBitrate / 2000)) },
      codec,
      appData: { source: 'screen' satisfies ProducerSource },
    });

    if (audioTrack?.readyState === 'live') {
      this.screenAudioProducer = await this.produceScreenAudio(sendTransport, audioTrack);
    }

    set({
      screen: {
        status: 'live',
        preset: presetId,
        hasAudio: Boolean(this.screenAudioProducer),
        echoRisk:
          Boolean(this.screenAudioProducer) &&
          !this.gameAudio &&
          capturesOwnAudio(videoTrack, audioTrack),
        audioSource: this.screenAudioProducer ? audioSourceOf(this.gameAudio) : null,
        stream: screenStream,
        error: null,
      },
    });
  }

  private produceScreenAudio(
    transport: types.Transport,
    track: MediaStreamTrack,
  ): Promise<types.Producer> {
    return transport.produce({
      track,
      stopTracks: false,
      // Music, films and game audio: stereo, no DTX, at a bitrate where Opus is transparent.
      codecOptions: {
        opusStereo: true,
        opusDtx: false,
        opusFec: true,
        opusMaxAverageBitrate: SCREEN_AUDIO_BITRATE,
        opusMaxPlaybackRate: 48_000,
      },
      encodings: [{ maxBitrate: SCREEN_AUDIO_BITRATE }],
      appData: { source: 'screen-audio' satisfies ProducerSource },
    });
  }

  /**
   * Hands the share to the desktop app's own capture when this machine has one: behind a game
   * that takes the whole graphics card it keeps the frames the browser's capture loses.
   * Experimental, on unless turned off in the settings: whole monitors, no preview. Answers `false`
   * when the browser should capture instead.
   */
  private async startNativeShare(): Promise<boolean> {
    const native = useSettingsStore.getState().nativeCapture ? desktop?.nativeCapture : undefined;
    const codec = await native?.probe().catch(() => null);
    if (!native || !codec) return false;
    // The app's own picker. A monitor, or a game covering one, is captured by the app; any
    // other window goes to the browser's capture, which the app answers without asking again.
    if (native.choose) {
      const choice = await native.choose().catch(() => 'browser' as const);
      if (get().screen.status !== 'starting') return true;
      if (choice === 'cancelled') {
        set({ screen: screenOff });
        return true;
      }
      if (choice === 'browser') return false;
    }
    this.nativeShare = codec;
    void native.engineProblem?.().then((problem) => {
      this.engineProblem = problem;
    });
    this.unsubscribeNativeStats ??=
      native.onStats?.((stats) => {
        if (this.nativeShare) this.nativeStats = stats;
      }) ?? null;
    this.unsubscribeNative ??= native.onEnded(() => {
      if (!this.nativeShare) return;
      void this.stopScreenShare().then(() =>
        set({ screen: { ...screenOff, error: 'A captura nativa parou.' } }),
      );
    });
    try {
      if (await this.publishNative()) return true;
    } catch (error) {
      console.warn('[voice] native capture failed, capturing in the browser', error);
    }
    // Releases whatever the attempt left behind; the state stays `starting` for the caller.
    const preset = get().screen.preset;
    await this.stopScreenShare();
    set({ screen: { ...screenOff, status: 'starting', preset } });
    return false;
  }

  /** Asks the media service for an ingest and points the app's capture at it. */
  private async publishNative(): Promise<boolean> {
    const native = desktop?.nativeCapture;
    const rpc = this.connection?.rpc;
    const presetId = get().screen.preset;
    const codec = this.nativeShare;
    if (!native || !rpc || !presetId || !codec) return false;

    const preset = SCREEN_PRESETS[presetId];
    const ingest = await rpc.request('createIngest', { codec });
    this.nativeProducerId = ingest.producerId;
    // The engine sends a small picture of what it captures (app 0.11.2 and later).
    this.stopNativePreview();
    if (native.onPreview) {
      const preview = createNativePreview();
      this.nativePreview = preview;
      this.unsubscribePreview = preview
        ? native.onPreview((picture) => preview.push(picture))
        : null;
    }
    try {
      await native.start({
        ingest,
        codec,
        frameRate: preset.frameRate,
        bitrate: Math.max(...preset.bitrates),
        width: preset.width,
        height: preset.height,
      });
    } catch (error) {
      this.stopNativePreview();
      throw error;
    }
    // The sound of the game alone when one covers the screen. Otherwise the system's, which
    // still comes through the browser: the app answers that request with the same monitor and
    // no picker, and only the audio track is kept.
    if (!this.gameAudio && !this.nativeAudio) {
      this.gameAudio = await startGameAudio();
      if (!this.gameAudio) this.nativeAudio = await this.captureNativeAudio(preset);
    }
    if (!this.nativeShare) {
      this.gameAudio?.stop();
      this.gameAudio = null;
      this.nativeAudio?.track.stop();
      this.nativeAudio = null;
      return false;
    }
    const { sendTransport } = this;
    const audioTrack = this.gameAudio?.track ?? this.nativeAudio?.track;
    if (sendTransport && audioTrack?.readyState === 'live') {
      this.screenAudioProducer = await this.produceScreenAudio(sendTransport, audioTrack).catch(
        (error: unknown) => {
          console.warn('[voice] failed to publish the system audio', error);
          return null;
        },
      );
    }
    set({
      screen: {
        status: 'live',
        preset: presetId,
        hasAudio: Boolean(this.screenAudioProducer),
        echoRisk: Boolean(this.screenAudioProducer) && Boolean(this.nativeAudio?.echoRisk),
        audioSource: this.screenAudioProducer ? audioSourceOf(this.gameAudio) : null,
        stream: this.nativePreview?.stream ?? null,
        error: null,
      },
    });
    return true;
  }

  private stopNativePreview(): void {
    this.unsubscribePreview?.();
    this.unsubscribePreview = null;
    this.nativePreview?.stop();
    this.nativePreview = null;
  }

  private async captureNativeAudio(
    preset: ScreenPreset,
  ): Promise<{ track: MediaStreamTrack; echoRisk: boolean } | null> {
    try {
      const stream = await this.captureDisplay(preset, true);
      const [video] = stream.getVideoTracks();
      const [audio] = stream.getAudioTracks();
      const echoRisk = video ? capturesOwnAudio(video, audio) : false;
      // The picture is the app's job; a second capture of it would cost what this path saves.
      for (const track of stream.getVideoTracks()) track.stop();
      return audio ? { track: audio, echoRisk } : null;
    } catch (error) {
      console.warn('[voice] system audio unavailable for the native capture', error);
      return null;
    }
  }

  // --- camera -------------------------------------------------------------------------------

  private async publishCamera(): Promise<void> {
    const { sendTransport, device, cameraStream } = this;
    if (!sendTransport || !device || !cameraStream) return;
    const [track] = cameraStream.getVideoTracks();
    if (!track || track.readyState !== 'live') throw new Error('camera track ended');

    const vp8 = device.rtpCapabilities.codecs?.find(
      (codec) => codec.mimeType.toLowerCase() === 'video/vp8',
    );
    this.cameraProducer = await sendTransport.produce({
      track,
      stopTracks: false,
      encodings: simulcastEncodings(CAMERA),
      codecOptions: { videoGoogleStartBitrate: 600 },
      codec: vp8,
      appData: { source: 'camera' satisfies ProducerSource },
    });
    set({ camera: { status: 'live', stream: cameraStream, error: null } });
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

      // The user may have stopped watching while the consumer was being set up.
      if (isScreenSource(source) && !this.watched.has(peerId)) {
        consumer.close();
        connection.rpc.request('closeConsumer', { consumerId: consumer.id }).catch(() => undefined);
        return;
      }

      const entry: ActiveConsumer = { consumer, peerId, source };
      this.consumers.set(consumer.id, entry);

      if (consumer.kind === 'audio') {
        const audio = new Audio();
        audio.srcObject = new MediaStream([consumer.track]);
        entry.audio = audio;
        this.applyVolume(entry);
        this.routeOutput(audio);
        audio.play().catch((error: unknown) => console.warn('[voice] playback blocked', error));
      } else if (source === 'camera') {
        const layer = this.cameraLayers.get(peerId);
        if (layer !== undefined) {
          await connection.rpc.request('setConsumerLayers', {
            consumerId: consumer.id,
            spatialLayer: layer,
          });
        }
        set({ cameras: { ...get().cameras, [peerId]: new MediaStream([consumer.track]) } });
      } else {
        const layer = this.wantedLayers.get(peerId);
        if (layer !== undefined) {
          await connection.rpc.request('setConsumerLayers', {
            consumerId: consumer.id,
            spatialLayer: layer,
          });
        }
        this.setWatching(peerId, {
          stream: new MediaStream([consumer.track]),
          spatialLayer: get().watching[peerId]?.spatialLayer ?? null,
        });
      }
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
    if (entry.source === 'camera') {
      const { [entry.peerId]: _gone, ...cameras } = get().cameras;
      set({ cameras });
    }
    if (entry.source === 'screen' && get().watching[entry.peerId]) {
      this.setWatching(entry.peerId, { stream: null, spatialLayer: null });
    }
  }

  // --- stats --------------------------------------------------------------------------------

  private startStats(): void {
    if (this.statsTimer !== null) window.clearInterval(this.statsTimer);
    this.statsTimer = window.setInterval(() => void this.pollStats(), STATS_INTERVAL_MS);
  }

  private async pollStats(): Promise<void> {
    const { sendTransport, recvTransport } = this;
    if (!sendTransport || !recvTransport || sendTransport.closed || recvTransport.closed) return;
    try {
      const [sent, received] = await Promise.all([
        sendTransport.getStats(),
        recvTransport.getStats(),
      ]);
      const { stats, sample } = collectConnectionStats(sent, received, this.statsSample);
      this.statsSample = sample;

      const streamStats: Record<string, StreamStats> = {};
      // The same numbers go to the media service, which keeps them as the stream's telemetry.
      const rpc = this.connection?.rpc;
      const preset = get().screen.preset;
      if (this.screenProducer && !this.screenProducer.closed) {
        const result = collectOutboundStreamStats(
          await this.screenProducer.getStats(),
          this.streamSamples.get(SELF_STREAM) ?? null,
        );
        this.streamSamples.set(SELF_STREAM, result.sample);
        streamStats[SELF_STREAM] = result.stats;
        const { stats: own } = result;
        rpc?.notify('stream-stats', {
          role: 'sender',
          producerId: this.screenProducer.id,
          sample: {
            captureFps: own.captureFps ?? null,
            sentFps: own.fps,
            encodeMs: own.encodeMs ?? null,
            width: own.width,
            height: own.height,
            kbps: own.kbps,
            limitation: own.limitation ?? null,
            encoder: own.encoder?.slice(0, 64) ?? null,
            preset,
          },
        });
      } else if (this.nativeProducerId) {
        // The capture engine measures itself; ffmpeg, on older apps, says nothing, and then
        // only the preset tells what the stream aimed at.
        const engine = this.nativeStats;
        // The engine lowers the bitrate when the server reports lost packets.
        const aimed = preset ? Math.max(...SCREEN_PRESETS[preset].bitrates) : null;
        const squeezed = engine !== null && aimed !== null && engine.bitrate < aimed * 0.95;
        if (engine) {
          streamStats[SELF_STREAM] = {
            width: engine.width,
            height: engine.height,
            fps: Math.round(engine.sentFps),
            kbps: Math.round(engine.kbps),
            lossPercent: engine.lossPercent,
            codec: 'H264',
            limitation: squeezed ? 'bandwidth' : null,
            encodeMs: engine.encodeMs,
            encoder: engine.encoder,
            captureFps: Math.round(engine.captureFps),
          };
        }
        rpc?.notify('stream-stats', {
          role: 'sender',
          producerId: this.nativeProducerId,
          sample: {
            captureFps: engine?.captureFps ?? null,
            sentFps: engine?.sentFps ?? null,
            encodeMs: engine?.encodeMs ?? null,
            width: engine?.width ?? null,
            height: engine?.height ?? null,
            kbps: engine ? Math.round(engine.kbps) : null,
            limitation: squeezed ? 'bandwidth' : null,
            // Without the engine's numbers it is ffmpeg: an app before 0.11, or an engine that
            // did not start on this machine. The version tells which.
            encoder: (
              engine?.encoder ??
              `ffmpeg · app ${desktop?.version ?? '?'}${this.engineProblem ? ` · ${this.engineProblem}` : ''}`
            ).slice(0, 64),
            preset,
          },
        });
      }
      for (const { consumer, peerId, source } of this.consumers.values()) {
        if (source !== 'screen' || consumer.closed) continue;
        const result = collectInboundStreamStats(
          await consumer.getStats(),
          this.streamSamples.get(peerId) ?? null,
        );
        this.streamSamples.set(peerId, result.sample);
        streamStats[peerId] = result.stats;
        if (!consumer.paused) {
          rpc?.notify('stream-stats', {
            role: 'viewer',
            producerId: consumer.producerId,
            sample: result.viewer,
          });
        }
      }
      set({ stats, streamStats });
    } catch {
      // Transports can close between the check and the call.
    }
  }
}
