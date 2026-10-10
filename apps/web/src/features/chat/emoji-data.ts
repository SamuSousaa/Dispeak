export interface EmojiEntry {
  /** The character itself. */
  char: string;
  /** Name in Portuguese, e.g. `fogo`. */
  label: string;
  /** Name and keywords, lowercase and without accents, for searching. */
  search: string;
}

export interface EmojiGroup {
  id: string;
  label: string;
  /** Emoji that stands for the group in the navigation rail. */
  icon: string;
  emojis: EmojiEntry[];
}

/** Unicode groups in display order (2, the skin tone components, is left out). */
const GROUPS: Array<{ group: number; id: string; label: string; icon: string }> = [
  { group: 0, id: 'smileys', label: 'CARINHAS E EMOÇÕES', icon: '😀' },
  { group: 1, id: 'people', label: 'PESSOAS E GESTOS', icon: '👋' },
  { group: 3, id: 'nature', label: 'ANIMAIS E NATUREZA', icon: '🐶' },
  { group: 4, id: 'food', label: 'COMIDA E BEBIDA', icon: '🍕' },
  { group: 6, id: 'activities', label: 'ATIVIDADES', icon: '⚽' },
  { group: 5, id: 'travel', label: 'VIAGENS E LUGARES', icon: '🚗' },
  { group: 7, id: 'objects', label: 'OBJETOS', icon: '💡' },
  { group: 8, id: 'symbols', label: 'SÍMBOLOS', icon: '❤️' },
  { group: 9, id: 'flags', label: 'BANDEIRAS', icon: '🏁' },
];

/** Windows has no flag glyphs: the regional indicators show up as two letters. */
const noFlags = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');

/** Lowercase, accents removed: `Coração` and `coracao` find the same things. */
export const normalize = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

interface RawEmoji {
  unicode: string;
  label: string;
  group?: number;
  order?: number;
  tags?: string[];
}

/** Turns the raw list into the groups the picker shows. */
export function buildGroups(raw: RawEmoji[], withFlags = !noFlags): EmojiGroup[] {
  return GROUPS.filter((meta) => withFlags || meta.id !== 'flags').map((meta) => ({
    id: meta.id,
    label: meta.label,
    icon: meta.icon,
    emojis: raw
      .filter((entry) => entry.group === meta.group)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((entry) => ({
        char: entry.unicode,
        label: entry.label,
        search: normalize([entry.label, ...(entry.tags ?? [])].join(' ')),
      })),
  }));
}

/** Emojis whose name or keywords contain every word of the query. */
export function searchEmojis(groups: EmojiGroup[], query: string, limit = 120): EmojiEntry[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const found: EmojiEntry[] = [];
  for (const group of groups) {
    for (const emoji of group.emojis) {
      if (words.every((word) => emoji.search.includes(word))) {
        found.push(emoji);
        if (found.length >= limit) return found;
      }
    }
  }
  return found;
}

let loading: Promise<EmojiGroup[]> | null = null;

/**
 * The full emoji set with Portuguese names. It is a few hundred kilobytes, so it is only
 * downloaded the first time a picker opens.
 */
export function loadEmojis(): Promise<EmojiGroup[]> {
  loading ??= import('emojibase-data/pt/compact.json')
    .then((module) => buildGroups(module.default as RawEmoji[]))
    .catch((error: unknown) => {
      loading = null;
      throw error;
    });
  return loading;
}
