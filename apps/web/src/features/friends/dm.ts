import type { Channel, Guild, Member } from '@frequencia/shared';
import { useGatewayStore } from '../gateway/gateway-store';

/** Route segment of the home screen (friends and private conversations), where a guild id goes. */
export const HOME = '@me';

export interface Conversation {
  guild: Guild;
  /** The other person. */
  friend: Member;
  online: boolean;
  text: Channel | undefined;
  voice: Channel | undefined;
  /** Someone is in the call of this conversation right now. */
  inCall: boolean;
}

/** A private conversation as the user sees it, or `null` for a server. */
export function conversationOf(guild: Guild | undefined, selfId: string): Conversation | null {
  if (guild?.kind !== 'dm') return null;
  const friend = guild.members.find((member) => member.user.id !== selfId);
  if (!friend) return null;
  return {
    guild,
    friend,
    online: guild.onlineUserIds.includes(friend.user.id),
    text: guild.channels.find((channel) => channel.type === 'text'),
    voice: guild.channels.find((channel) => channel.type === 'voice'),
    inCall: guild.voiceStates.length > 0,
  };
}

/** Every private conversation of the user, by the friend's name. */
export function useConversations(selfId: string): Conversation[] {
  const guilds = useGatewayStore((state) => state.guilds);
  return Object.values(guilds)
    .map((guild) => conversationOf(guild, selfId))
    .filter((entry): entry is Conversation => entry !== null)
    .sort((a, b) => a.friend.user.displayName.localeCompare(b.friend.user.displayName, 'pt-BR'));
}
