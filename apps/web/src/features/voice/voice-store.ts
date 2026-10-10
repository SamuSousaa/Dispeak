import type { VoicePeer } from '@frequencia/shared';
import { create } from 'zustand';
import type { NoiseSuppressionMode } from '../settings/settings-store';
import type { ScreenPresetId } from './screen-presets';

export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface VoiceConnectionStats {
  rttMs: number | null;
  sendKbps: number | null;
  receiveKbps: number | null;
  /** Inbound packet loss over the last interval, in percent. */
  lossPercent: number | null;
  audioCodec: string | null;
}

export interface ScreenShareState {
  status: 'off' | 'starting' | 'live';
  preset: ScreenPresetId | null;
  /** Whether the browser handed over system/tab audio along with the video. */
  hasAudio: boolean;
  /** Local capture, shown as the streamer's own preview. */
  stream: MediaStream | null;
  error: string | null;
}

export interface CameraState {
  status: 'off' | 'starting' | 'live';
  /** Local capture, shown in the user's own tile. */
  stream: MediaStream | null;
  error: string | null;
}

export interface WatchedStream {
  /** `null` until the first video consumer is ready. */
  stream: MediaStream | null;
  /** Simulcast layer the server is currently forwarding (0 = lowest). */
  spatialLayer: number | null;
}

export interface StreamLayerStats {
  rid: string;
  width: number | null;
  height: number | null;
  fps: number | null;
  kbps: number | null;
}

/** Real numbers for one stream, read from `getStats()` of its producer or consumer. */
export interface StreamStats {
  width: number | null;
  height: number | null;
  fps: number | null;
  kbps: number | null;
  lossPercent: number | null;
  codec: string | null;
  /** Outgoing streams only: one entry per simulcast layer. */
  layers?: StreamLayerStats[];
  /** Outgoing streams only: why the encoder is holding back (`cpu`, `bandwidth`), if it is. */
  limitation?: string | null;
}

/** Key used in `streamStats` for the local user's own screen share. */
export const SELF_STREAM = 'self';

export interface VoiceState {
  status: VoiceStatus;
  error: string | null;
  /** Human readable name of the joined channel. */
  channelName: string | null;
  /** Opaque id of the joined channel, as known by the caller of `joinVoice`. */
  channelId: string | null;
  selfId: string | null;
  muted: boolean;
  deafened: boolean;
  /** Push-to-talk: the key is being held, so the microphone is open. */
  pttHeld: boolean;
  /** False when no microphone could be opened; the user is then listen-only. */
  micAvailable: boolean;
  /** What is cleaning the microphone right now; `null` while there is no microphone. */
  noiseSuppression: NoiseSuppressionMode | null;
  /** Remote participants keyed by session id. */
  peers: Record<string, VoicePeer>;
  /** Session ids currently speaking (may include `selfId`). */
  speaking: string[];
  stats: VoiceConnectionStats;
  screen: ScreenShareState;
  camera: CameraState;
  /** Cameras of the other participants, keyed by session id. Always received. */
  cameras: Record<string, MediaStream>;
  /** Streams this client chose to watch, keyed by the streamer's session id. */
  watching: Record<string, WatchedStream>;
  /** Keyed by streamer session id, or `SELF_STREAM` for the local share. */
  streamStats: Record<string, StreamStats>;
}

export const emptyVoiceStats: VoiceConnectionStats = {
  rttMs: null,
  sendKbps: null,
  receiveKbps: null,
  lossPercent: null,
  audioCodec: null,
};

export const screenOff: ScreenShareState = {
  status: 'off',
  preset: null,
  hasAudio: false,
  stream: null,
  error: null,
};

export const cameraOff: CameraState = { status: 'off', stream: null, error: null };

export const initialVoiceState: VoiceState = {
  status: 'idle',
  error: null,
  channelName: null,
  channelId: null,
  selfId: null,
  muted: false,
  deafened: false,
  pttHeld: false,
  micAvailable: true,
  noiseSuppression: null,
  peers: {},
  speaking: [],
  stats: emptyVoiceStats,
  screen: screenOff,
  camera: cameraOff,
  cameras: {},
  watching: {},
  streamStats: {},
};

export const useVoiceStore = create<VoiceState>(() => initialVoiceState);

/** True when the peer is publishing a screen share. */
export function isLive(peer: VoicePeer): boolean {
  return peer.producers.some((producer) => producer.source === 'screen');
}
