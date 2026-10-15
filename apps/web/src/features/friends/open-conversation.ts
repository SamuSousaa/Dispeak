import { navigateTo } from '../../lib/app-navigation';
import { chatApi } from '../chat/chat-store';
import { applyGatewayEvent } from '../gateway/gateway-store';
import { conversationsApi } from './conversations-api';

/**
 * Goes to the private conversation with someone, started when there is none, and sends a first
 * message when one is given (the box on a profile card). The conversation is put in the local
 * copy at once: the gateway may tell about it a moment after the answer arrives.
 */
export async function openConversation(userId: string, message?: string): Promise<void> {
  const guild = await conversationsApi.open(userId);
  applyGatewayEvent('GUILD_SYNC', guild);
  const text = guild.channels.find((channel) => channel.type === 'text');
  const content = message?.trim();
  if (content && text) await chatApi.send(text.id, content);
  navigateTo(text ? `/app/${guild.id}/${text.id}` : `/app/${guild.id}`);
}
