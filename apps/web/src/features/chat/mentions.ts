import { EVERYONE_MENTION, formatMention, MENTION_PATTERN, type Guild } from '@frequencia/shared';
import { memberName } from '../guilds/permissions';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'mention'; userId: string; name: string }
  | { type: 'everyone' }
  | { type: 'link'; href: string };

const URL_PATTERN = /https?:\/\/[^\s<>]+[^\s<>.,;:!?)\]'"]/g;

/** Splits message content into plain text, mentions and links, ready to render. */
export function parseContent(
  content: string,
  guild: Guild,
  mentionEveryone: boolean,
): ContentPart[] {
  const tokens = new RegExp(
    `${MENTION_PATTERN.source}|(${EVERYONE_MENTION})|(${URL_PATTERN.source})`,
    'g',
  );
  const parts: ContentPart[] = [];
  let cursor = 0;
  for (const match of content.matchAll(tokens)) {
    const [whole, userId, everyone, url] = match;
    const index = match.index;
    let part: ContentPart | null = null;
    if (userId && guild.members.some((member) => member.user.id === userId)) {
      part = { type: 'mention', userId, name: memberName(guild, userId) };
    } else if (everyone && mentionEveryone) {
      part = { type: 'everyone' };
    } else if (url) {
      part = { type: 'link', href: url };
    }
    if (!part) continue; // Unknown user, or @todos without the permission: leave as text.
    if (index > cursor) parts.push({ type: 'text', text: content.slice(cursor, index) });
    parts.push(part);
    cursor = index + whole.length;
  }
  if (cursor < content.length) parts.push({ type: 'text', text: content.slice(cursor) });
  return parts;
}

/**
 * The composer shows mentions as `@Name`; the wire format is `<@id>`. These two functions
 * convert between them using the members of the guild.
 */
export function toWireContent(text: string, guild: Guild): string {
  // Longest names first, so "@Ana Maria" is not cut short by a member called "Ana".
  const names = guild.members
    .map((member) => ({ id: member.user.id, label: `@${memberName(guild, member.user.id)}` }))
    .sort((a, b) => b.label.length - a.label.length);
  let result = text;
  for (const { id, label } of names) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Only whole mentions count: not "email@Ana" and not "@Anabela".
    const pattern = new RegExp(`(^|\\s)${escaped}(?![\\p{L}\\p{N}_])`, 'gu');
    result = result.replace(pattern, (_whole, before: string) => `${before}${formatMention(id)}`);
  }
  return result;
}

export function toEditableContent(content: string, guild: Guild): string {
  return content.replace(MENTION_PATTERN, (whole, userId: string) =>
    guild.members.some((member) => member.user.id === userId)
      ? `@${memberName(guild, userId)}`
      : whole,
  );
}

/** The `@partial` being typed right before the caret, if any. */
export function mentionQueryAt(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const match = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  const query = match[2] ?? '';
  return { start: caret - query.length - 1, query };
}
