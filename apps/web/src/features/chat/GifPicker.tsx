import type { Gif } from '@frequencia/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { chatApi } from './chat-store';

const SEARCH_DELAY_MS = 350;

/** GIF search above the composer. Picking one sends it right away, as its link. */
export function GifPicker({
  onPick,
  onClose,
}: {
  onPick: (gif: Gif) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');

  // Search once the typing pauses, not on every key.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(text.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [text]);

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

  const result = useQuery({
    queryKey: ['gifs', query.toLowerCase()],
    queryFn: () => chatApi.gifs(query),
    staleTime: 5 * 60 * 1000,
    retry: 0,
  });
  const gifs = result.data?.gifs ?? [];

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="GIFs"
      className="anim-pop absolute right-0 bottom-full z-10 mb-1 flex h-96 max-h-[60dvh] w-96 max-w-full flex-col border border-line-strong bg-surface-2"
    >
      <div className="shrink-0 border-b border-line p-2">
        <input
          type="search"
          className="field"
          autoFocus
          value={text}
          placeholder="Buscar GIF"
          aria-label="Buscar GIF"
          onChange={(event) => setText(event.target.value)}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
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
      <p className="label shrink-0 border-t border-line px-2 py-1 text-muted">
        {query ? 'RESULTADOS' : 'EM ALTA'} · POWERED BY GIPHY
      </p>
    </div>
  );
}
