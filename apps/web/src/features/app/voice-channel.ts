import type { Channel } from '@frequencia/shared';
import { useMemo } from 'react';
import { ApiError } from '../../lib/http';
import { guildApi } from '../guilds/guild-api';
import { joinVoice } from '../voice/voice-actions';
import { VoiceAccessError } from '../voice/voice-session';
import { useVoiceStore } from '../voice/voice-store';

/** Joins a guild voice channel; the API decides, per attempt, whether the user may enter. */
export function connectToVoiceChannel(channel: Channel): void {
  void joinVoice({
    channelId: channel.id,
    channelName: channel.name,
    getToken: async () => {
      try {
        return await guildApi.voiceToken(channel.id);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          throw new VoiceAccessError('Você não tem permissão para entrar neste canal.');
        }
        throw error;
      }
    },
  });
}

/** User ids speaking right now in the voice channel this client is connected to. */
export function useSpeakingUserIds(selfUserId: string | undefined): Set<string> {
  const speaking = useVoiceStore((state) => state.speaking);
  const peers = useVoiceStore((state) => state.peers);
  const selfId = useVoiceStore((state) => state.selfId);
  return useMemo(() => {
    const userIds = new Set<string>();
    for (const peerId of speaking) {
      if (peerId === selfId) {
        if (selfUserId) userIds.add(selfUserId);
      } else {
        const userId = peers[peerId]?.userId;
        if (userId) userIds.add(userId);
      }
    }
    return userIds;
  }, [speaking, peers, selfId, selfUserId]);
}
