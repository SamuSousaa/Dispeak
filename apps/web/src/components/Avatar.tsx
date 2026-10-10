import { API_PREFIX } from '@frequencia/shared';
import { useState } from 'react';
import { cx } from '../lib/cx';

/** Address of a profile picture or server icon; they are public and cached for good. */
export const pictureUrl = (id: string) => `${API_PREFIX}/images/${id}`;

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1] ?? '') : '';
  return (last ? `${first[0] ?? ''}${last[0] ?? ''}` : first.slice(0, 2)).toUpperCase();
}

interface AvatarProps {
  name: string;
  /** Picture id; without one the initials stand in. */
  picture: string | null | undefined;
  /** Side in CSS pixels. */
  size: number;
  className?: string;
}

/** Square picture of a person or a server, falling back to their initials. Decorative. */
export function Avatar({ name, picture, size, className }: AvatarProps) {
  // An old message may point to a picture its author has since replaced.
  const [missing, setMissing] = useState<string | null>(null);
  const shown = picture && picture !== missing ? picture : null;
  return (
    <span
      aria-hidden="true"
      data-testid="avatar"
      data-picture={Boolean(shown)}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.38)) }}
      className={cx(
        'display inline-flex shrink-0 items-center justify-center overflow-hidden bg-surface-2 leading-none text-muted',
        className,
      )}
    >
      {shown ? (
        <img
          src={pictureUrl(shown)}
          onError={() => setMissing(shown)}
          alt=""
          draggable={false}
          className="h-full w-full object-cover"
        />
      ) : (
        initials(name)
      )}
    </span>
  );
}
