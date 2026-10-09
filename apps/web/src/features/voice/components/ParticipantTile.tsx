import { Button } from '../../../components/Button';
import { cx } from '../../../lib/cx';
import { LiveBadge } from './LiveBadge';

interface ParticipantTileProps {
  name: string;
  isSelf?: boolean;
  speaking: boolean;
  muted: boolean;
  deafened: boolean;
  /** The participant is sharing a screen. */
  live?: boolean;
  /** The local user is currently watching that share. */
  watching?: boolean;
  onWatch?: () => void;
  onUnwatch?: () => void;
  /** Smaller rendition used when streams take the main area. */
  compact?: boolean;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1] ?? '') : '';
  return (last ? `${first[0] ?? ''}${last[0] ?? ''}` : first.slice(0, 2)).toUpperCase();
}

/** One participant of a voice channel. The accent outline means "speaking right now". */
export function ParticipantTile({
  name,
  isSelf = false,
  speaking,
  muted,
  deafened,
  live = false,
  watching = false,
  onWatch,
  onUnwatch,
  compact = false,
}: ParticipantTileProps) {
  const status = deafened ? 'SURDO' : muted ? 'MUDO' : null;
  return (
    <div
      data-testid="participant"
      data-speaking={speaking}
      data-muted={muted}
      data-deafened={deafened}
      data-live={live}
      className={cx(
        'relative flex flex-col border bg-surface transition-colors',
        compact ? 'h-full w-44 shrink-0' : 'aspect-video',
        speaking ? 'border-accent' : 'border-line',
      )}
    >
      {live && <LiveBadge className="absolute top-0 left-0" />}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2">
        <span
          aria-hidden="true"
          className={cx(
            'display transition-colors',
            compact ? 'text-xl' : 'text-4xl',
            speaking ? 'text-accent' : 'text-muted',
          )}
        >
          {initials(name)}
        </span>
        {live && !isSelf && (
          <Button
            variant={watching ? 'active' : 'primary'}
            aria-pressed={watching}
            aria-label={watching ? `Parar de assistir ${name}` : `Assistir ${name}`}
            className={cx(compact && 'h-6 px-1.5')}
            onClick={watching ? onUnwatch : onWatch}
          >
            {watching ? 'ASSISTINDO' : 'ASSISTIR'}
          </Button>
        )}
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
