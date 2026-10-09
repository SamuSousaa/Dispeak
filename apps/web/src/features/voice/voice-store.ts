import type { VoicePeer } from '@frequencia/shared';
import { create } from 'zustand';

export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface VoiceConnectionStats {
  rttMs: number | null;
  sendKbps: number | null;
  receiveKbps: number | null;
  /** Inbound packet loss over the last interval, in percent. */
  lossPercent: number | null;
  audioCodec: string | null;
}

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
  /** False when no microphone could be opened; the user is then listen-only. */
  micAvailable: boolean;
  /** Remote participants keyed by session id. */
  peers: Record<string, VoicePeer>;
  /** Session ids currently speaking (may include `selfId`). */
  speaking: string[];
  stats: VoiceConnectionStats;
}

export const emptyVoiceStats: VoiceConnectionStats = {
  rttMs: null,
  sendKbps: null,
  receiveKbps: null,
  lossPercent: null,
  audioCodec: null,
};

export const initialVoiceState: VoiceState = {
  status: 'idle',
  error: null,
  channelName: null,
  channelId: null,
  selfId: null,
  muted: false,
  deafened: false,
  micAvailable: true,
  peers: {},
  speaking: [],
  stats: emptyVoiceStats,
};

export const useVoiceStore = create<VoiceState>(() => initialVoiceState);
