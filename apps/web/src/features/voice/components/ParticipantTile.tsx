import { useEffect, useRef, type HTMLAttributes } from 'react';
import { Avatar, initials } from '../../../components/Avatar';
import { Button } from '../../../components/Button';
import { MediaVideo } from '../../../components/MediaVideo';
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
  /** Profile picture id, shown while the camera is off. */
  picture?: string | null;
  /** The participant's camera, when it is on. */
  video?: MediaStream | null;
  /** Reports the displayed height (CSS px) of a remote camera, to pick its quality. */
  onVideoViewport?: (cssHeight: number) => void;
  /** How this user hears the participant, when not at full volume (`VOL 40%`). */
  volumeNote?: string | null;
  /** Handlers that open the participant's menu (right click, long press). */
  menu?: HTMLAttributes<HTMLDivElement>;
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
  picture = null,
  video = null,
  onVideoViewport,
  volumeNote = null,
  menu,
}: ParticipantTileProps) {
  const status = deafened ? 'SURDO' : muted ? 'MUDO' : null;
  const containerRef = useRef<HTMLDivElement>(null);
  const reportViewport = useRef(onVideoViewport);
  useEffect(() => {
    reportViewport.current = onVideoViewport;
  });

  useEffect(() => {
    const element = containerRef.current;
    if (!element || !video) return;
    let timer: number | undefined;
    const report = () => reportViewport.current?.(element.clientHeight);
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(report, 250);
    });
    observer.observe(element);
    report();
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [video]);

  return (
    <div
      ref={containerRef}
      data-camera={Boolean(video)}
      data-testid="participant"
      data-speaking={speaking}
      data-muted={muted}
      data-deafened={deafened}
      data-live={live}
      {...menu}
      className={cx(
        'anim-rise relative flex flex-col border bg-surface transition-colors',
        compact ? 'h-full w-44 shrink-0' : 'aspect-video',
        speaking ? 'border-accent' : 'border-line',
      )}
    >
      {live && <LiveBadge className="absolute top-0 left-0 z-10" />}
      <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-2">
        {video && (
          <MediaVideo
            stream={video}
            muted
            data-testid="camera-video"
            // Your own camera is mirrored, the way a mirror shows you.
            className={cx('absolute inset-0 h-full w-full object-cover', isSelf && '-scale-x-100')}
          />
        )}
        {picture && !video && (
          <Avatar
            name={name}
            picture={picture}
            size={compact ? 44 : 88}
            className={cx('border transition-colors', speaking ? 'border-accent' : 'border-line')}
          />
        )}
        <span
          aria-hidden="true"
          className={cx(
            'display transition-colors',
            picture && !video && 'hidden',
            compact ? 'text-xl' : 'text-4xl',
            speaking ? 'text-accent' : 'text-muted',
            video && 'invisible',
          )}
        >
          {initials(name)}
        </span>
        {live && !isSelf && (
          <Button
            variant={watching ? 'active' : 'primary'}
            aria-pressed={watching}
            aria-label={watching ? `Parar de assistir ${name}` : `Assistir ${name}`}
            className={cx('relative', compact && 'h-6 px-1.5', video && 'bg-bg')}
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
        {volumeNote && !status && (
          <span className="shrink-0 text-muted" data-testid="volume-note">
            {volumeNote}
          </span>
        )}
        {status && <span className="shrink-0 text-danger">{status}</span>}
        {!status && speaking && <span className="sr-only">falando</span>}
      </div>
    </div>
  );
}
