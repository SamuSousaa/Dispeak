import { GUILD_SOUND_EVENTS, type GuildSoundEvent, type VoicePeer } from '@frequencia/shared';

/** The same events a guild owner can set a sound for. */
export const SOUND_EVENTS = GUILD_SOUND_EVENTS;
export type SoundEvent = GuildSoundEvent;

export const SOUND_LABELS: Record<SoundEvent, string> = {
  join: 'Alguém entra na chamada',
  leave: 'Alguém sai da chamada',
  streamStart: 'Uma transmissão começa',
  streamStop: 'Uma transmissão termina',
};

/** The part of the voice state the notification sounds depend on. */
export interface SoundSnapshot {
  /** The voice channel the state belongs to; tells which guild the sounds come from. */
  channelId?: string | null;
  status: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';
  peers: Record<string, VoicePeer>;
  screen: { status: 'off' | 'starting' | 'live' };
}

const inCall = (status: SoundSnapshot['status']) =>
  status === 'connected' || status === 'reconnecting';
const isStreaming = (peer: VoicePeer) =>
  peer.producers.some((producer) => producer.source === 'screen');

/**
 * Sounds a change of voice state calls for. The local user and the other participants are
 * treated alike: joining, leaving, starting and stopping a screen share. A reconnection is
 * silent, and so is finding people already in the channel when joining it.
 */
export function soundEventsFor(previous: SoundSnapshot, next: SoundSnapshot): SoundEvent[] {
  if (previous.status === 'connecting' && next.status === 'connected') return ['join'];
  if (inCall(previous.status) && !inCall(next.status)) return ['leave'];
  if (previous.status !== 'connected' || next.status !== 'connected') return [];

  const events = new Set<SoundEvent>();
  if (previous.screen.status !== 'live' && next.screen.status === 'live') events.add('streamStart');
  if (previous.screen.status === 'live' && next.screen.status === 'off') events.add('streamStop');

  for (const [id, peer] of Object.entries(next.peers)) {
    const before = previous.peers[id];
    if (!before) {
      events.add('join');
    } else if (isStreaming(peer) !== isStreaming(before)) {
      events.add(isStreaming(peer) ? 'streamStart' : 'streamStop');
    }
  }
  for (const id of Object.keys(previous.peers)) {
    if (!next.peers[id]) events.add('leave');
  }
  return [...events];
}
