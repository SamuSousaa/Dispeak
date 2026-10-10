import { describe, expect, it } from 'vitest';
import { buildGroups, normalize, searchEmojis } from './emoji-data';

const raw = [
  { unicode: '🔥', label: 'fogo', group: 5, order: 30, tags: ['chama', 'quente'] },
  { unicode: '❤️', label: 'coração vermelho', group: 0, order: 20, tags: ['amor'] },
  { unicode: '😀', label: 'rosto risonho', group: 0, order: 10, tags: ['sorriso'] },
  { unicode: '🏻', label: 'pele clara', group: 2, order: 1 },
  { unicode: '🇧🇷', label: 'bandeira: Brasil', group: 9, order: 40 },
  { unicode: '🇦', label: 'indicador regional A' },
];

describe('emoji data', () => {
  it('groups by category in display order, without skin tone components', () => {
    const groups = buildGroups(raw, true);
    expect(groups.find((group) => group.id === 'smileys')?.emojis.map((e) => e.char)).toEqual([
      '😀',
      '❤️',
    ]);
    expect(groups.flatMap((group) => group.emojis).map((e) => e.char)).not.toContain('🏻');
    expect(groups.flatMap((group) => group.emojis).map((e) => e.char)).not.toContain('🇦');
  });

  it('leaves flags out where the system cannot draw them', () => {
    expect(buildGroups(raw, false).some((group) => group.id === 'flags')).toBe(false);
    expect(buildGroups(raw, true).find((group) => group.id === 'flags')?.emojis).toHaveLength(1);
  });

  it('searches names and keywords, ignoring accents and case', () => {
    const groups = buildGroups(raw, true);
    expect(searchEmojis(groups, 'coracao').map((e) => e.char)).toEqual(['❤️']);
    expect(searchEmojis(groups, 'CHAMA').map((e) => e.char)).toEqual(['🔥']);
    expect(searchEmojis(groups, 'rosto ris').map((e) => e.char)).toEqual(['😀']);
    expect(searchEmojis(groups, 'nada disso')).toEqual([]);
    expect(searchEmojis(groups, '   ')).toEqual([]);
  });

  it('normalizes text', () => {
    expect(normalize('Coração Ç ÁÉÍ')).toBe('coracao c aei');
  });
});
