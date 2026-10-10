import type { Message } from '@frequencia/shared';
import { describe, expect, it } from 'vitest';
import { sumUnread, unreadState } from './unread-store';

const ME = '00000000-0000-4000-8000-00000000000a';
const ANA = '00000000-0000-4000-8000-00000000000b';

const message = (channelId: string, patch: Partial<Message> = {}): Message => ({
  id: '00000000-0000-4000-8000-000000000001',
  channelId,
  guildId: 'g1',
  author: { id: ANA, username: 'ana', displayName: 'Ana' },
  content: 'oi',
  attachments: [],
  reactions: [],
  replyTo: null,
  mentions: [],
  mentionEveryone: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  editedAt: null,
  ...patch,
});

describe('unread counters', () => {
  it('count what others write, with mentions apart', () => {
    let state = { channels: {} };
    state = unreadState.add(state, message('c1'), ME);
    state = unreadState.add(state, message('c1', { mentions: [ME] }), ME);
    state = unreadState.add(state, message('c1', { mentionEveryone: true }), ME);
    state = unreadState.add(state, message('c2', { guildId: 'g2' }), ME);
    expect(state.channels).toEqual({
      c1: { guildId: 'g1', count: 3, mentions: 2 },
      c2: { guildId: 'g2', count: 1, mentions: 0 },
    });
  });

  it('ignore the user’s own messages', () => {
    const state = { channels: {} };
    const mine = message('c1', { author: { id: ME, username: 'eu', displayName: 'Eu' } });
    expect(unreadState.add(state, mine, ME)).toBe(state);
  });

  it('clear one channel or a whole guild', () => {
    const state = {
      channels: {
        c1: { guildId: 'g1', count: 2, mentions: 1 },
        c2: { guildId: 'g1', count: 1, mentions: 0 },
        c3: { guildId: 'g2', count: 4, mentions: 0 },
      },
    };
    expect(Object.keys(unreadState.clear(state, 'c1').channels)).toEqual(['c2', 'c3']);
    expect(unreadState.clear(state, 'nope')).toBe(state);
    expect(Object.keys(unreadState.clearGuild(state, 'g1').channels)).toEqual(['c3']);
  });

  it('add up', () => {
    expect(
      sumUnread([
        { guildId: 'g1', count: 2, mentions: 1 },
        { guildId: 'g1', count: 5, mentions: 0 },
      ]),
    ).toEqual({ count: 7, mentions: 1 });
    expect(sumUnread([])).toEqual({ count: 0, mentions: 0 });
  });
});
