import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type TouchEvent,
} from 'react';
import { create } from 'zustand';
import { cx } from '../lib/cx';

export type MenuEntry =
  | {
      type?: 'item';
      label: string;
      /** Shown on the right: a state or a shortcut. */
      hint?: string;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { type: 'separator' }
  /** Free content, such as a slider. `close` dismisses the menu. */
  | { type: 'custom'; key: string; render: (close: () => void) => ReactNode };

interface MenuState {
  open: { x: number; y: number; title: string; entries: MenuEntry[]; wide: boolean } | null;
}

const useMenuStore = create<MenuState>(() => ({ open: null }));

/** Opens the menu at a point of the viewport. Entries that are `false` are left out. */
export function openContextMenu(
  point: { x: number; y: number },
  title: string,
  entries: Array<MenuEntry | false | null | undefined>,
  options: { /** Room for a panel instead of a list of actions. */ wide?: boolean } = {},
): void {
  const kept = entries.filter((entry): entry is MenuEntry => Boolean(entry));
  // No lone, leading, trailing or doubled separators.
  const tidy = kept.filter(
    (entry, index) =>
      entry.type !== 'separator' ||
      (index > 0 && index < kept.length - 1 && kept[index - 1]?.type !== 'separator'),
  );
  while (tidy.at(-1)?.type === 'separator') tidy.pop();
  if (tidy.length === 0) return;
  useMenuStore.setState({
    open: { ...point, title, entries: tidy, wide: options.wide ?? false },
  });
}

export const isContextMenuOpen = (): boolean => useMenuStore.getState().open !== null;

export function closeContextMenu(): void {
  if (useMenuStore.getState().open) useMenuStore.setState({ open: null });
}

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;

// One finger, one long press at a time: kept outside the components so a re-render in the
// middle of a press cannot lose track of it.
let timer: number | undefined;
let start: { x: number; y: number } | null = null;
const cancel = () => {
  window.clearTimeout(timer);
  start = null;
};
const claimed = new WeakSet<Event>();

/**
 * Props that make an element open a menu: right click with a mouse, long press on a touch
 * screen (where there is no right click). `build` runs when the menu opens, so it sees the
 * current state.
 */
export function contextMenu(
  title: string,
  build: () => Array<MenuEntry | false | null | undefined>,
  options: { wide?: boolean } = {},
) {
  return {
    onContextMenu: (event: MouseEvent) => {
      // Text fields and links inside keep the browser's own menu (copy, paste, open in new tab).
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, [contenteditable="true"], a[target="_blank"]')) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
      openContextMenu({ x: event.clientX, y: event.clientY }, title, build(), options);
    },
    onTouchStart: (event: TouchEvent) => {
      const touch = event.touches[0];
      // The innermost element with a menu wins; its ancestors see the same event afterwards.
      if (!touch || event.touches.length > 1 || claimed.has(event.nativeEvent)) return;
      claimed.add(event.nativeEvent);
      cancel();
      const point = { x: touch.clientX, y: touch.clientY };
      start = point;
      timer = window.setTimeout(() => {
        start = null;
        openContextMenu(point, title, build(), options);
      }, LONG_PRESS_MS);
    },
    onTouchMove: (event: TouchEvent) => {
      const touch = event.touches[0];
      if (
        start &&
        touch &&
        Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > MOVE_TOLERANCE_PX
      ) {
        cancel();
      }
    },
    onTouchEnd: cancel,
    onTouchCancel: cancel,
  };
}

/** The one menu of the app; mount it once, near the root. */
export function ContextMenuHost() {
  const menu = useMenuStore((state) => state.open);
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  // Keep the menu inside the viewport, whatever corner it was opened in.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!menu || !element) {
      setPosition(null);
      return;
    }
    const margin = 8;
    // On a phone the menu is a sheet at the bottom, wherever the finger was.
    if (window.innerWidth < 640) {
      setPosition(null);
      return;
    }
    const { width, height } = element.getBoundingClientRect();
    setPosition({
      left: Math.max(margin, Math.min(menu.x, window.innerWidth - width - margin)),
      top: Math.max(margin, Math.min(menu.y, window.innerHeight - height - margin)),
    });
    element.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) closeContextMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeContextMenu();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const items = [
        ...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []),
      ];
      if (items.length === 0) return;
      event.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(current + step + items.length) % items.length]?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', closeContextMenu);
    window.addEventListener('resize', closeContextMenu);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', closeContextMenu);
      window.removeEventListener('resize', closeContextMenu);
    };
  }, [menu]);

  if (!menu) return null;
  const sheet = window.innerWidth < 640;

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={menu.title}
      data-testid="context-menu"
      style={position ?? (sheet ? undefined : { left: menu.x, top: menu.y, visibility: 'hidden' })}
      className={cx(
        'fixed z-50 overflow-y-auto border border-line-strong bg-surface-2',
        sheet
          ? 'anim-pop inset-x-2 bottom-2 max-h-[80dvh]'
          : 'anim-fade max-h-[calc(100dvh-16px)] max-w-[calc(100vw-16px)]',
        !sheet && (menu.wide ? 'w-[22rem]' : 'w-60'),
      )}
      onContextMenu={(event) => event.preventDefault()}
    >
      <p className="label truncate border-b border-line px-3 py-1.5 text-muted">{menu.title}</p>
      {menu.entries.map((entry, index) => {
        if (entry.type === 'separator') {
          return <div key={`separator-${index}`} role="separator" className="h-px bg-line" />;
        }
        if (entry.type === 'custom') {
          return (
            <div key={entry.key} className="px-3 py-2">
              {entry.render(closeContextMenu)}
            </div>
          );
        }
        return (
          <button
            key={entry.label}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            onClick={() => {
              closeContextMenu();
              entry.onSelect();
            }}
            className={cx(
              'label flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors pointer-coarse:py-3.5',
              'hover:bg-surface focus-visible:bg-surface focus-visible:-outline-offset-2 disabled:opacity-40',
              entry.danger ? 'text-danger' : 'text-fg hover:text-accent focus-visible:text-accent',
            )}
          >
            <span className={entry.hint ? 'shrink-0' : 'truncate'}>{entry.label}</span>
            {entry.hint && <span className="min-w-0 truncate text-muted">{entry.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}
