import { formatMention, type Guild, type Message, type MessagePage } from '@frequencia/shared';
import { describe, expect, it } from 'vitest';
import { flattenMessages, messageCache, type MessageCache } from './chat-store';
import { mentionQueryAt, parseContent, toEditableContent, toWireContent } from './mentions';

const ANA = '00000000-0000-4000-8000-00000000000a';
const ANA_MARIA = '00000000-0000-4000-8000-00000000000b';
const GHOST = '00000000-0000-4000-8000-0000000000ff';

const guild = {
  id: '00000000-0000-4000-8000-000000000001',
  members: [
    { user: { id: ANA, username: 'ana', displayName: 'Ana' }, nickname: null, roleIds: [] },
    {
      user: { id: ANA_MARIA, username: 'anamaria', displayName: 'Ana M.' },
      nickname: 'Ana Maria',
      roleIds: [],
    },
  ],
} as unknown as Guild;

const message = (id: number, content = `m${id}`): Message => ({
  id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
  channelId: 'c',
  guildId: guild.id,
  author: { id: ANA, username: 'ana', displayName: 'Ana' },
  content,
  mentions: [],
  mentionEveryone: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  editedAt: null,
});

const page = (ids: number[], nextCursor: string | null = null): MessagePage => ({
  messages: ids.map((id) => message(id)),
  nextCursor,
});

/** Newest page first, as the infinite query stores them. */
const cache = (): MessageCache => ({
  pages: [page([4, 5, 6]), page([1, 2, 3])],
  pageParams: [undefined, 'cursor'],
});

describe('message cache', () => {
  it('flattens pages into chronological order', () => {
    expect(flattenMessages(cache()).map((entry) => entry.content)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
      'm6',
    ]);
    expect(flattenMessages(undefined)).toEqual([]);
  });

  it('appends new messages to the newest page, ignoring duplicates', () => {
    const added = messageCache.add(cache(), message(7));
    expect(flattenMessages(added).at(-1)?.content).toBe('m7');
    expect(added.pages[1]).toEqual(cache().pages[1]);
    expect(messageCache.add(added, message(7))).toBe(added);
  });

  it('updates and removes messages wherever they are', () => {
    const updated = messageCache.update(cache(), message(2, 'editada'));
    expect(flattenMessages(updated)[1]?.content).toBe('editada');

    const removed = messageCache.remove(cache(), message(5).id);
    expect(flattenMessages(removed).map((entry) => entry.content)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
      'm6',
    ]);
  });
});

describe('mentions', () => {
  it('converts names to the wire format, longest name first', () => {
    expect(toWireContent('oi @Ana Maria e @Ana!', guild)).toBe(
      `oi ${formatMention(ANA_MARIA)} e ${formatMention(ANA)}!`,
    );
    // Only whole mentions are converted.
    expect(toWireContent('email@Ana e @Anabela', guild)).toBe('email@Ana e @Anabela');
  });

  it('converts the wire format back for editing, leaving unknown users alone', () => {
    const wire = `${formatMention(ANA_MARIA)} e ${formatMention(GHOST)}`;
    expect(toEditableContent(wire, guild)).toBe(`@Ana Maria e ${formatMention(GHOST)}`);
    expect(toWireContent(toEditableContent(wire, guild), guild)).toBe(wire);
  });

  it('parses text, mentions, @todos and links', () => {
    const parts = parseContent(
      `oi ${formatMention(ANA)}, veja https://example.com/a?b=1. @todos ${formatMention(GHOST)}`,
      guild,
      true,
    );
    expect(parts).toEqual([
      { type: 'text', text: 'oi ' },
      { type: 'mention', userId: ANA, name: 'Ana' },
      { type: 'text', text: ', veja ' },
      { type: 'link', href: 'https://example.com/a?b=1' },
      { type: 'text', text: '. ' },
      { type: 'everyone' },
      { type: 'text', text: ` ${formatMention(GHOST)}` },
    ]);
  });

  it('treats @todos as plain text when the author could not mention everyone', () => {
    expect(parseContent('@todos oi', guild, false)).toEqual([{ type: 'text', text: '@todos oi' }]);
  });

  it('never produces markup from message content', () => {
    const parts = parseContent('<img src=x onerror=alert(1)> javascript:alert(1)', guild, false);
    expect(parts).toEqual([
      { type: 'text', text: '<img src=x onerror=alert(1)> javascript:alert(1)' },
    ]);
  });

  it('finds the mention being typed before the caret', () => {
    expect(mentionQueryAt('oi @an', 6)).toEqual({ start: 3, query: 'an' });
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQueryAt('oi @ana tudo bem', 16)).toBeNull();
    expect(mentionQueryAt('email@dominio', 13)).toBeNull();
    expect(mentionQueryAt('oi @an', 2)).toBeNull();
  });
});
