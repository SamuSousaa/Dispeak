import { useEffect, useRef, type ReactNode } from 'react';
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
 * the rest of the page inert.
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
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself. So does the end of a drag
      // that started inside (selecting text and letting go outside): only a press that began
      // on the backdrop closes the dialog.
      onMouseDown={(event) => {
        pressedOutside.current = event.target === ref.current;
      }}
      onClick={(event) => {
        if (event.target === ref.current && pressedOutside.current) onClose();
        pressedOutside.current = false;
      }}
      className={cx(
        'border-line-strong bg-surface p-0 text-fg backdrop:bg-black/70',
        side
          ? 'my-0 mr-0 ml-auto h-dvh max-h-dvh w-[27rem] max-w-full border-l'
          : 'm-auto max-h-[min(90dvh,720px)] w-[calc(100vw-2rem)] border',
        !side && (wide ? 'max-w-3xl' : 'max-w-md'),
      )}
    >
      <div className={cx('flex flex-col', side ? 'h-full' : 'max-h-[min(90dvh,720px)]')}>
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {eyebrow && <p className="label text-muted">{eyebrow}</p>}
            <h2 className="display truncate text-lg text-fg">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="label shrink-0 text-muted transition-colors hover:text-accent"
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
