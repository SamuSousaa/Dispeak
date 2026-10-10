import type { Guild, Message } from '@frequencia/shared';
import { useAuthStore } from '../auth/auth-store';
import { parseContent } from '../chat/mentions';
import { memberName } from '../guilds/permissions';
import { useSettingsStore } from '../settings/settings-store';

/**
 * System notification for a message that mentions the user, when they asked for it and the
 * browser allows it. Clicking it brings the tab forward and runs `onOpen`.
 */
export function notifyMention(
  message: Message,
  guild: Guild | undefined,
  onOpen: () => void,
): void {
  if (
    !useSettingsStore.getState().desktopNotifications ||
    useAuthStore.getState().user?.presence === 'dnd' ||
    typeof Notification === 'undefined' ||
    Notification.permission !== 'granted'
  ) {
    return;
  }
  const channel = guild?.channels.find((entry) => entry.id === message.channelId);
  const author = guild ? memberName(guild, message.author.id) : message.author.displayName;
  const text = guild
    ? parseContent(message.content, guild, message.mentionEveryone)
        .map((part) => {
          if (part.type === 'text') return part.text;
          if (part.type === 'mention') return `@${part.name}`;
          return part.type === 'everyone' ? '@todos' : part.href;
        })
        .join('')
    : message.content;

  try {
    const notification = new Notification(channel ? `${author} em ${channel.name}` : author, {
      body: text || 'Enviou uma imagem',
      // One notification per message, even with the app open in two tabs.
      tag: message.id,
    });
    notification.onclick = () => {
      window.focus();
      onOpen();
      notification.close();
    };
  } catch {
    // Some mobile browsers expose the API but only let a service worker use it.
  }
}
