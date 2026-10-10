import type { Gif } from '@frequencia/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { cx } from '../../lib/cx';
import { chatApi } from './chat-store';
import { EmojiBrowser } from './EmojiGrid';

export type ExpressionTab = 'gif' | 'emoji';

const SEARCH_DELAY_MS = 350;
/** Shortcuts shown before anything is typed in the GIF tab. */
const GIF_SUGGESTIONS = ['risada', 'aplausos', 'sim', 'não', 'triste', 'dança', 'gato', 'futebol'];

function GifBrowser({
  text,
  onSuggest,
  onPick,
}: {
  text: string;
  onSuggest: (term: string) => void;
  onPick: (gif: Gif) => void;
}) {
  const [query, setQuery] = useState(text.trim());

  // Search once the typing pauses, not on every key.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(text.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [text]);

  const result = useQuery({
    queryKey: ['gifs', query.toLowerCase()],
    queryFn: () => chatApi.gifs(query),
    staleTime: 5 * 60 * 1000,
    retry: 0,
  });
  const gifs = result.data?.gifs ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!text.trim() && (
          <ul aria-label="Sugestões de busca" className="mb-2 flex flex-wrap gap-1.5">
            {GIF_SUGGESTIONS.map((term) => (
              <li key={term}>
                <button
                  type="button"
                  onClick={() => onSuggest(term)}
                  className="label border border-line-strong px-2 py-1 text-muted transition-colors hover:border-accent hover:text-accent"
                >
                  {term}
                </button>
              </li>
            ))}
          </ul>
        )}
        {result.isPending && <p className="label text-muted">BUSCANDO</p>}
        {result.isError && (
          <p role="alert" className="label text-danger">
            A BUSCA DE GIF NÃO RESPONDEU. TENTE DE NOVO.
          </p>
        )}
        {result.isSuccess && gifs.length === 0 && (
          <p className="label text-muted">NADA ENCONTRADO</p>
        )}
        {/* Two columns of varying heights, like a wall of pictures. */}
        <ul className="columns-2 gap-2">
          {gifs.map((gif) => (
            <li key={gif.id} className="mb-2 break-inside-avoid">
              <button
                type="button"
                data-testid="gif"
                aria-label={gif.title || 'GIF'}
                title={gif.title}
                onClick={() => onPick(gif)}
                style={{ aspectRatio: `${gif.width} / ${gif.height}` }}
                className="block w-full border border-line bg-surface transition-colors hover:border-accent"
              >
                <img
                  src={gif.previewUrl}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-cover"
                />
              </button>
            </li>
          ))}
        </ul>
      </div>
      <p className="label flex h-10 shrink-0 items-center border-t border-line px-3 text-muted">
        {query ? 'RESULTADOS' : 'EM ALTA'} · POWERED BY GIPHY
      </p>
    </div>
  );
}

interface ExpressionPickerProps {
  tab: ExpressionTab;
  onTab: (tab: ExpressionTab) => void;
  /** Whether this server has the GIF search. */
  gifs: boolean;
  onEmoji: (emoji: string) => void;
  onGif: (gif: Gif) => void;
  onClose: () => void;
}

/**
 * The one panel for everything that is not typed: tabs on top, a search field that follows the
 * tab, and the content below. It floats above the composer, on the side of its buttons.
 */
export function ExpressionPicker({
  tab,
  onTab,
  gifs,
  onEmoji,
  onGif,
  onClose,
}: ExpressionPickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const current: ExpressionTab = gifs ? tab : 'emoji';

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  // Each tab searches its own thing: start clean, with the field ready to type in.
  useEffect(() => {
    setText('');
    search.current?.focus();
  }, [current]);

  const tabs: Array<{ id: ExpressionTab; label: string }> = [
    ...(gifs ? [{ id: 'gif' as const, label: 'GIFS' }] : []),
    { id: 'emoji', label: 'EMOJI' },
  ];

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Emojis e GIFs"
      data-testid="expression-picker"
      className="anim-pop absolute right-0 bottom-full z-20 mb-1 flex h-[28rem] max-h-[60dvh] w-[26rem] max-w-full flex-col border border-line-strong bg-surface-2"
    >
      <div className="shrink-0 border-b border-line">
        <div role="tablist" className="flex">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={current === entry.id}
              onClick={() => onTab(entry.id)}
              className={cx(
                'label border-b-2 px-3 py-2 transition-colors',
                current === entry.id
                  ? 'border-accent text-accent'
                  : 'border-transparent text-muted hover:text-fg',
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="p-2 pt-1.5">
          <input
            ref={search}
            type="search"
            className="field"
            value={text}
            placeholder={current === 'gif' ? 'Buscar GIF' : 'Buscar emoji'}
            aria-label={current === 'gif' ? 'Buscar GIF' : 'Buscar emoji'}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
      </div>
      {current === 'gif' ? (
        <GifBrowser text={text} onSuggest={setText} onPick={onGif} />
      ) : (
        <EmojiBrowser query={text} onPick={onEmoji} />
      )}
    </div>
  );
}
