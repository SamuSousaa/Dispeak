import type { Guild, VoiceState } from '@frequencia/shared';
import type { PresenceService } from '../../gateway/presence';
import { toVoiceState, type VoiceStateStore } from '../voice/voice-state';
import { guildPayloadFor, type GuildSnapshot } from './snapshot';

export interface LiveState {
  presence: PresenceService;
  voiceStates: VoiceStateStore;
}

export interface GuildLiveData {
  onlineUserIds: string[];
  voiceStates: VoiceState[];
}

/** Who is online and who is in voice in a guild, read from Redis. */
export async function loadGuildLiveData(
  live: LiveState,
  snapshot: GuildSnapshot,
): Promise<GuildLiveData> {
  const voiceChannelIds = [...snapshot.channels.values()]
    .filter((channel) => channel.type === 'voice')
    .map((channel) => channel.id);
  const [onlineUserIds, voiceEntries] = await Promise.all([
    live.presence.onlineAmong([...snapshot.members.keys()]),
    live.voiceStates.listChannels(voiceChannelIds),
  ]);
  return { onlineUserIds, voiceStates: voiceEntries.map(toVoiceState) };
}

/** Builds the guild payload for one member, live data included. */
export async function buildGuildPayload(
  live: LiveState,
  snapshot: GuildSnapshot,
  userId: string,
): Promise<Guild> {
  return guildPayloadFor(snapshot, userId, await loadGuildLiveData(live, snapshot));
}
