import { cx } from '../lib/cx';

/** Three bars rising in turn: something is on its way. They stand still under reduced motion. */
export function Signal({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cx('signal', className)}>
      <i />
      <i />
      <i />
    </span>
  );
}

/** A wait in the middle of the interface, said in a label: `▮▮▮ CARREGANDO MENSAGENS`. */
export function Loading({ label, className }: { label: string; className?: string }) {
  return (
    <p role="status" className={cx('label flex items-center gap-2 text-muted', className)}>
      <Signal />
      {label}
    </p>
  );
}
