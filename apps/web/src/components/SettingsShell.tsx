import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '../lib/cx';
import { CloseButton } from './Dialog';

export interface ShellPage<Id extends string> {
  id: Id;
  label: string;
  /** Heading the page is listed under in the index. */
  group: string;
  /** Pages that destroy something (delete the channel) stand apart, in red. */
  danger?: boolean;
}

/** A section matching a search: the page it is on and where in it. */
export interface ShellSearchResult<Id extends string> {
  page: Id;
  section: string;
  /** "VOZ · PROCESSAMENTO DA VOZ" */
  label: string;
}

/** Search text without case or accents: "Notificações" finds "notificacoes". */
export function normalizeSearch(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/**
 * Settings laid out as a split panel, like an IDE: the index of pages on the left, grouped,
 * the page on the right with its title and the close button. On a phone, one at a time: the
 * page, with a way back to the index. Goes inside `<Dialog settings>`.
 */
export function SettingsShell<Id extends string>({
  title,
  pages,
  page,
  onPage,
  heading,
  search,
  onSearchResult,
  indexFooter,
  children,
}: {
  /** What these settings are about, above the index: "CONFIGURAÇÕES", "#GERAL". */
  title: string;
  pages: Array<ShellPage<Id>>;
  page: Id;
  onPage: (page: Id) => void;
  /** Shown next to the page title: a short note on what the page affects. */
  heading?: ReactNode;
  /** When given, the index starts with a search over the sections. */
  search?: (query: string) => Array<ShellSearchResult<Id>>;
  onSearchResult?: (result: ShellSearchResult<Id>) => void;
  indexFooter?: ReactNode;
  children: ReactNode;
}) {
  const [query, setQuery] = useState('');
  // On a phone the page shows first, since the dialog opens on one; the index is a tap away.
  const [indexOpen, setIndexOpen] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const current = pages.find((entry) => entry.id === page);
  const results = search && query.trim() ? search(query) : null;

  // A new page starts at its top.
  useEffect(() => {
    content.current?.scrollTo({ top: 0 });
  }, [page]);

  const groups: Array<{ name: string; pages: Array<ShellPage<Id>> }> = [];
  for (const entry of pages) {
    const group = groups.find((existing) => existing.name === entry.group);
    if (group) group.pages.push(entry);
    else groups.push({ name: entry.group, pages: [entry] });
  }

  const go = (next: Id) => {
    onPage(next);
    setIndexOpen(false);
  };

  return (
    <div className="flex h-full min-h-0">
      <nav
        aria-label={`Índice de ${title.toLowerCase()}`}
        className={cx(
          'flex w-60 shrink-0 flex-col border-r border-line bg-surface-2',
          'max-sm:w-full max-sm:border-r-0',
          !indexOpen && 'max-sm:hidden',
        )}
      >
        <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
          <p className="label truncate text-muted">{title}</p>
          <CloseButton className="sm:hidden" />
        </div>
        {search && (
          <div className="border-b border-line p-3">
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="BUSCAR"
              aria-label="Buscar nas configurações"
              className="label h-8 w-full border border-line-strong bg-bg px-2 text-fg placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto py-2">
          {results ? (
            results.length === 0 ? (
              <p className="label px-4 py-2 text-muted">NADA ENCONTRADO</p>
            ) : (
              <ul aria-label="Resultados da busca">
                {results.map((result) => (
                  <li key={`${result.page}:${result.section}`}>
                    <button
                      type="button"
                      className="label w-full truncate border-l-2 border-transparent px-4 py-1.5 text-left text-fg transition-colors hover:border-accent hover:text-accent"
                      onClick={() => {
                        setQuery('');
                        setIndexOpen(false);
                        onSearchResult?.(result);
                      }}
                    >
                      {result.label}
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <div role="tablist" aria-orientation="vertical" aria-label={title}>
              {groups.map((group) => (
                <div key={group.name} className="mb-3">
                  {group.name && <p className="label px-4 pb-1 text-muted">{group.name}</p>}
                  {group.pages.map((entry) => {
                    const selected = entry.id === page;
                    return (
                      <button
                        key={entry.id}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        onClick={() => go(entry.id)}
                        className={cx(
                          'label-lg block w-full truncate border-l-2 px-4 py-1.5 text-left transition-colors',
                          selected
                            ? 'border-accent bg-surface text-accent'
                            : entry.danger
                              ? 'border-transparent text-danger hover:border-danger'
                              : 'border-transparent text-fg hover:border-accent hover:text-accent',
                        )}
                      >
                        {entry.label}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
        {indexFooter && <div className="border-t border-line p-3">{indexFooter}</div>}
      </nav>

      <section
        aria-label={current?.label}
        className={cx('flex min-w-0 flex-1 flex-col', indexOpen && 'max-sm:hidden')}
      >
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-line px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              className="label shrink-0 text-muted transition-colors hover:text-accent sm:hidden"
              onClick={() => setIndexOpen(true)}
            >
              ‹ ÍNDICE
            </button>
            <h2 className="display truncate text-lg text-fg">{current?.label}</h2>
            {heading}
          </div>
          <CloseButton />
        </header>
        <div ref={content} key={page} className="anim-view min-h-0 flex-1 overflow-y-auto">
          {children}
        </div>
      </section>
    </div>
  );
}

/**
 * One block of a settings page, numbered like the channels. `scope` says whether the choice
 * follows the account to every device or stays on this one.
 */
export function SettingsSection({
  id,
  number,
  title,
  scope,
  wide = false,
  children,
}: {
  /** Anchor the search jumps to. */
  id?: string;
  /** Uses the whole width of the page, for tables and side-by-side lists. */
  wide?: boolean;
  number: string;
  title: string;
  scope?: 'account' | 'device';
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-2 border-b border-line">
      <h3 className="label flex items-center justify-between gap-3 border-b border-line bg-surface-2 px-4 py-2 text-fg sm:px-6">
        <span className="min-w-0 truncate">
          <span className="text-muted">{number}.</span> {title}
        </span>
        {scope && (
          <span className="shrink-0 text-muted">
            {scope === 'account' ? 'ACOMPANHA SUA CONTA' : 'SÓ NESTE APARELHO'}
          </span>
        )}
      </h3>
      <div className={cx('flex flex-col gap-4 p-4 sm:px-6', !wide && 'max-w-2xl')}>{children}</div>
    </section>
  );
}
