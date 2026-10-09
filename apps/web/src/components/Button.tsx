import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from '../lib/cx';

type Variant = 'default' | 'primary' | 'danger' | 'active';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  /** Renders without the surrounding brackets (icon-like, compact buttons). */
  bare?: boolean;
  children: ReactNode;
}

const variants: Record<Variant, string> = {
  default: 'text-fg border-line-strong hover:border-accent hover:text-accent',
  primary: 'bg-accent text-on-accent border-accent hover:bg-transparent hover:text-accent',
  danger: 'text-danger border-line-strong hover:border-danger',
  active: 'text-accent border-accent',
};

/** Bracketed mono button: `[ TRANSMITIR ]`. */
export function Button({
  variant = 'default',
  bare = false,
  className,
  children,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        'label inline-flex h-8 items-center justify-center gap-1 border px-2.5 whitespace-nowrap',
        'transition-colors disabled:opacity-40 disabled:hover:border-line-strong',
        variants[variant],
        className,
      )}
      {...props}
    >
      {!bare && <span aria-hidden="true">[</span>}
      <span>{children}</span>
      {!bare && <span aria-hidden="true">]</span>}
    </button>
  );
}
