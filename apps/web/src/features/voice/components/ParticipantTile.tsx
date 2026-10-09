import { cx } from '../../../lib/cx';

interface ParticipantTileProps {
  name: string;
  isSelf?: boolean;
  speaking: boolean;
  muted: boolean;
  deafened: boolean;
  /** Smaller rendition used when streams take the main area. */
  compact?: boolean;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : [name.slice(0, 2)];
  return letters
    .map((part) => (parts.length > 1 ? (part?.[0] ?? '') : (part ?? '')))
    .join('')
    .toUpperCase();
}

/** One participant of a voice channel. The accent outline means "speaking right now". */
export function ParticipantTile({
  name,
  isSelf = false,
  speaking,
  muted,
  deafened,
  compact = false,
}: ParticipantTileProps) {
  const status = deafened ? 'SURDO' : muted ? 'MUDO' : null;
  return (
    <div
      data-testid="participant"
      data-speaking={speaking}
      data-muted={muted}
      data-deafened={deafened}
      className={cx(
        'relative flex flex-col border bg-surface transition-colors',
        compact ? 'h-full min-w-36' : 'aspect-video',
        speaking ? 'border-accent' : 'border-line',
      )}
    >
      <div
        aria-hidden="true"
        className={cx(
          'display flex min-h-0 flex-1 items-center justify-center transition-colors',
          compact ? 'text-xl' : 'text-4xl',
          speaking ? 'text-accent' : 'text-muted',
        )}
      >
        {initials(name)}
      </div>
      <div className="label flex items-center justify-between gap-2 border-t border-line px-2 py-1">
        <span className="truncate text-fg">
          {name}
          {isSelf && <span className="text-muted"> (VOCÊ)</span>}
        </span>
        {status && <span className="shrink-0 text-danger">{status}</span>}
        {!status && speaking && <span className="sr-only">falando</span>}
      </div>
    </div>
  );
}
