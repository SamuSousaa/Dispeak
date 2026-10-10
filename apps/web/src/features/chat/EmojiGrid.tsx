import { useEffect, useMemo, useRef, useState } from 'react';
import { openContextMenu } from '../../components/ContextMenu';
import { cx } from '../../lib/cx';
import { rememberEmoji, useUiStore } from '../app/ui-store';
import { loadEmojis, searchEmojis, type EmojiEntry, type EmojiGroup } from './emoji-data';

/** Offered first when reacting. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

const CELL = 36;

function EmojiButton({
  emoji,
  onPick,
  onHover,
}: {
  emoji: EmojiEntry;
  onPick: (char: string) => void;
  onHover: (emoji: EmojiEntry | null) => void;
}) {
  return (
    <button
      type="button"
      data-emoji={emoji.char}
      aria-label={`${emoji.char} ${emoji.label}`}
      title={emoji.label}
      // Keep focus (and the caret) where it was.
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={() => onHover(emoji)}
      onFocus={() => onHover(emoji)}
      onClick={() => onPick(emoji.char)}
      style={{ width: CELL, height: CELL }}
      className="flex items-center justify-center text-2xl leading-none transition-colors hover:bg-surface focus-visible:bg-surface focus-visible:-outline-offset-2"
    >
      {emoji.char}
    </button>
  );
}

/**
 * Every emoji, in categories, with a rail to jump between them and a line at the bottom naming
 * the one under the pointer. With a query it becomes a list of matches. The parent supplies the
 * search field and decides where the whole thing floats.
 */
export function EmojiBrowser({
  query,
  onPick,
}: {
  query: string;
  onPick: (emoji: string) => void;
}) {
  const [groups, setGroups] = useState<EmojiGroup[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [hovered, setHovered] = useState<EmojiEntry | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const recentChars = useUiStore((state) => state.recentEmojis);

  useEffect(() => {
    let cancelled = false;
    loadEmojis()
      .then((loaded) => !cancelled && setGroups(loaded))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const sections = useMemo(() => {
    if (!groups) return [];
    const all = new Map(groups.flatMap((group) => group.emojis).map((e) => [e.char, e]));
    const recent = recentChars.flatMap((char) => all.get(char) ?? []);
    return [
      ...(recent.length > 0
        ? [{ id: 'recent', label: 'USADOS COM FREQUÊNCIA', icon: '🕒', emojis: recent }]
        : []),
      ...groups,
    ];
  }, [groups, recentChars]);
  const matches = useMemo(() => (groups ? searchEmojis(groups, query) : []), [groups, query]);
  const searching = query.trim().length > 0;

  const pick = (char: string) => {
    rememberEmoji(char);
    onPick(char);
  };
  const jump = (id: string) => {
    setActive(id);
    scroller.current
      ?.querySelector(`[data-emoji-section="${id}"]`)
      ?.scrollIntoView({ block: 'start' });
  };

  if (failed) {
    return (
      <p role="alert" className="label p-3 text-danger">
        NÃO FOI POSSÍVEL CARREGAR OS EMOJIS
      </p>
    );
  }
  if (!groups) return <p className="label p-3 text-muted">CARREGANDO EMOJIS</p>;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        {!searching && (
          <nav
            aria-label="Categorias de emoji"
            className="flex w-9 shrink-0 flex-col overflow-y-auto border-r border-line"
          >
            {sections.map((section) => (
              <button
                key={section.id}
                type="button"
                aria-label={section.label}
                title={section.label}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => jump(section.id)}
                className={cx(
                  'flex h-9 shrink-0 items-center justify-center border-l-2 text-base transition-colors hover:bg-surface',
                  active === section.id ? 'border-accent bg-surface' : 'border-transparent',
                )}
              >
                {section.icon}
              </button>
            ))}
          </nav>
        )}
        <div ref={scroller} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {searching ? (
            matches.length > 0 ? (
              <div className="flex flex-wrap p-1">
                {matches.map((emoji) => (
                  <EmojiButton key={emoji.char} emoji={emoji} onPick={pick} onHover={setHovered} />
                ))}
              </div>
            ) : (
              <p className="label p-3 text-muted">NENHUM EMOJI COM ESSE NOME</p>
            )
          ) : (
            sections.map((section) => (
              <section
                key={section.id}
                data-emoji-section={section.id}
                // Sections off screen are not laid out until they are scrolled to.
                style={{
                  contentVisibility: 'auto',
                  containIntrinsicSize: `auto ${Math.ceil(section.emojis.length / 9) * CELL + 28}px`,
                }}
              >
                <h3 className="label sticky top-0 z-10 border-b border-line bg-surface-2 px-2 py-1 text-muted">
                  {section.label}
                </h3>
                <div className="flex flex-wrap p-1">
                  {section.emojis.map((emoji) => (
                    <EmojiButton
                      key={emoji.char}
                      emoji={emoji}
                      onPick={pick}
                      onHover={setHovered}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </div>
      <div
        className="flex h-10 shrink-0 items-center gap-2 border-t border-line px-3"
        aria-live="off"
      >
        {hovered ? (
          <>
            <span className="text-2xl leading-none">{hovered.char}</span>
            <span className="label truncate text-fg">{hovered.label}</span>
          </>
        ) : (
          <>
            <span className="label text-muted pointer-coarse:hidden">
              PASSE O MOUSE PARA VER O NOME
            </span>
            <span className="label hidden text-muted pointer-coarse:inline">
              TOQUE EM UM EMOJI PARA USAR
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function ReactionPanel({ onPick }: { onPick: (emoji: string) => void }) {
  const [query, setQuery] = useState('');
  return (
    <div className="-mx-3 -my-2 flex h-96 max-h-[60dvh] flex-col">
      <div className="shrink-0 border-b border-line p-2">
        <input
          type="search"
          className="field"
          autoFocus
          value={query}
          placeholder="Buscar emoji"
          aria-label="Buscar emoji"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <EmojiBrowser query={query} onPick={onPick} />
    </div>
  );
}

/** Floating emoji browser for reacting to a message, opened at a point of the screen. */
export function openReactionPicker(
  point: { x: number; y: number },
  onPick: (emoji: string) => void,
): void {
  openContextMenu(
    point,
    'REAGIR',
    [
      {
        type: 'custom',
        key: 'emojis',
        render: (close) => (
          <ReactionPanel
            onPick={(emoji) => {
              close();
              onPick(emoji);
            }}
          />
        ),
      },
    ],
    { wide: true },
  );
}
