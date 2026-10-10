import type { ButtonHTMLAttributes } from 'react';
import { cx } from '../lib/cx';
import { Icon, type IconName } from './Icon';

type Tone = 'default' | 'danger' | 'active';

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: IconName;
  /** Accessible name; also the tooltip unless `title` says more (e.g. the shortcut). */
  label: string;
  tone?: Tone;
}

const tones: Record<Tone, string> = {
  default: 'text-fg border-line-strong hover:border-accent hover:text-accent',
  danger: 'text-danger border-line-strong hover:border-danger',
  active: 'text-accent border-accent',
};

/** Square bordered button holding a single icon. */
export function IconButton({
  icon,
  label,
  tone = 'default',
  title,
  className,
  type = 'button',
  ...props
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={title ?? label}
      className={cx(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center border transition-colors',
        'disabled:opacity-40 disabled:hover:border-line-strong',
        tones[tone],
        className,
      )}
      {...props}
    >
      <Icon name={icon} />
    </button>
  );
}
