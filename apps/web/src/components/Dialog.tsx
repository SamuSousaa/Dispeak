import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { exitGhost } from '../lib/exit-ghost';
import { cx } from '../lib/cx';

interface DialogProps {
  title: string;
  /** Small label above the title, e.g. the section the dialog belongs to. */
  eyebrow?: string;
  onClose: () => void;
  children: ReactNode;
  /** Wider layout for settings screens. */
  wide?: boolean;
  /** Full-height panel docked to the right edge instead of a centered box. */
  side?: boolean;
}

/**
 * Modal built on the native <dialog>: the browser traps focus, closes on Escape and keeps
 * the rest of the page inert. Closed by the user, it plays its way out before telling the
 * parent, which then removes it; removed by the parent on its own (after saving, say), a
 * copy of it plays the same way out.
 */
export function Dialog({
  title,
  eyebrow,
  onClose,
  children,
  wide = false,
  side = false,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  /** Whether the press that may become a click started on the backdrop. */
  const pressedOutside = useRef(false);
  const [closing, setClosing] = useState(false);
  const told = useRef(false);
  const finish = () => {
    if (told.current) return;
    told.current = true;
    onClose();
  };
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    return exitGhost(dialog, side ? 'side' : 'scale', {
      backdrop: true,
      skip: () => told.current,
    });
  }, [side]);
  // The animation normally ends it; the timer covers a dialog that cannot animate.
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(finish, 400);
    return () => window.clearTimeout(timer);
  });

  useEffect(() => {
    // No cleanup on purpose: unmounting removes the element, and closing it here would fire
    // `close` (and therefore `onClose`) during React's development double-invocation.
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      aria-label={title}
      data-side={side || undefined}
      data-closing={closing || undefined}
      // Escape: the browser would close it at once.
      onCancel={(event) => {
        event.preventDefault();
        setClosing(true);
      }}
      onClose={finish}
      onAnimationEnd={(event) => {
        if (closing && event.target === ref.current) finish();
      }}
      // A click on the backdrop lands on the dialog element itself. So does the end of a drag
      // that started inside (selecting text and letting go outside): only a press that began
      // on the backdrop closes the dialog.
      onMouseDown={(event) => {
        pressedOutside.current = event.target === ref.current;
      }}
      onClick={(event) => {
        if (event.target === ref.current && pressedOutside.current) setClosing(true);
        pressedOutside.current = false;
      }}
      className={cx(
        'border-line-strong bg-surface p-0 text-fg backdrop:bg-black/70',
        // On a phone every dialog is a full screen: no margins to waste, nothing cut off.
        'max-sm:m-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:w-screen max-sm:max-w-none max-sm:border-0',
        side
          ? 'my-0 mr-0 ml-auto h-dvh max-h-dvh w-[27rem] max-w-full border-l'
          : 'm-auto max-h-[min(90dvh,720px)] w-[calc(100vw-2rem)] border',
        !side && (wide ? 'max-w-3xl' : 'max-w-md'),
      )}
    >
      <div
        className={cx(
          'safe-area flex flex-col max-sm:h-full max-sm:max-h-none',
          side ? 'h-full' : 'max-h-[min(90dvh,720px)]',
        )}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {eyebrow && <p className="label text-muted">{eyebrow}</p>}
            <h2 className="display truncate text-lg text-fg">{title}</h2>
          </div>
          <button
            type="button"
            onClick={() => setClosing(true)}
            aria-label="Fechar"
            className="label -m-2 shrink-0 p-2 text-muted transition-colors hover:text-accent"
          >
            [ X ]
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </dialog>
  );
}

/** Label + control row used inside dialogs. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="label text-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="label text-danger">
      {message}
    </p>
  );
}
