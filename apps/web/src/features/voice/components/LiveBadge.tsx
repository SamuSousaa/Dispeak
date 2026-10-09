import { cx } from '../../../lib/cx';

/** The "AO VIVO" marker: one of the few places the accent color is allowed. */
export function LiveBadge({ className }: { className?: string }) {
  return (
    <span className={cx('label bg-accent px-1.5 py-0.5 font-semibold text-on-accent', className)}>
      AO VIVO
    </span>
  );
}
