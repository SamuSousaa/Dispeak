import type { Channel, DmState, Guild, Member } from '@frequencia/shared';
import { useGatewayStore } from '../gateway/gateway-store';

/** Route segment of the home screen (friends and private conversations), where a guild id goes. */
export const HOME = '@me';

export interface Conversation {
  guild: Guild;
  /** The other person: a friend, or someone met in a server. */
  friend: Member;
  /** Friendship, message request and block, as this user sees them. */
  state: DmState;
  online: boolean;
  text: Channel | undefined;
  voice: Channel | undefined;
  /** Someone is in the call of this conversation right now. */
  inCall: boolean;
}

const noState: DmState = { friend: true, request: null, blocked: null };

/** A private conversation as the user sees it, or `null` for a server. */
export function conversationOf(guild: Guild | undefined, selfId: string): Conversation | null {
  if (guild?.kind !== 'dm') return null;
  const friend = guild.members.find((member) => member.user.id !== selfId);
  if (!friend) return null;
  return {
    guild,
    friend,
    state: guild.dm ?? noState,
    online: guild.onlineUserIds.includes(friend.user.id),
    text: guild.channels.find((channel) => channel.type === 'text'),
    voice: guild.channels.find((channel) => channel.type === 'voice'),
    inCall: guild.voiceStates.length > 0,
  };
}

/**
 * Whether a conversation shows among the others. A request waiting for this user has a list
 * of its own; a declined one, or one with nothing sent yet, does not show anywhere.
 */
export function isListed(conversation: Conversation): boolean {
  return conversation.state.request !== 'incoming' && conversation.state.request !== 'hidden';
}

function useAllConversations(selfId: string): Conversation[] {
  const guilds = useGatewayStore((state) => state.guilds);
  return Object.values(guilds)
    .map((guild) => conversationOf(guild, selfId))
    .filter((entry): entry is Conversation => entry !== null)
    .sort((a, b) => a.friend.user.displayName.localeCompare(b.friend.user.displayName, 'pt-BR'));
}

/** The private conversations of the user, by the other person's name. */
export function useConversations(selfId: string): Conversation[] {
  return useAllConversations(selfId).filter(isListed);
}

/** Conversations started by people who are not friends, waiting for this user to answer. */
export function useMessageRequests(selfId: string): Conversation[] {
  return useAllConversations(selfId).filter((entry) => entry.state.request === 'incoming');
}

/** The user's friends, each with the conversation they share. */
export function useFriends(selfId: string): Conversation[] {
  return useAllConversations(selfId).filter((entry) => entry.state.friend);
}

/** The conversation with someone, when there is one. */
export function conversationWith(selfId: string, userId: string): Conversation | null {
  for (const guild of Object.values(useGatewayStore.getState().guilds)) {
    const conversation = conversationOf(guild, selfId);
    if (conversation?.friend.user.id === userId) return conversation;
  }
  return null;
}
