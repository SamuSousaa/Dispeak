import { useEffect, useRef, useState, type HTMLAttributes } from 'react';
import { Avatar, initials } from '../../../components/Avatar';
import { Button } from '../../../components/Button';
import { MediaVideo } from '../../../components/MediaVideo';
import { cx } from '../../../lib/cx';
import { LiveBadge } from './LiveBadge';

interface ParticipantTileProps {
  name: string;
  /** Colour of the participant's highest role, for the name. */
  nameColor?: string;
  /** Silenced by a moderator. */
  serverMuted?: boolean;
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
  /** The tile has the main area to itself. */
  focused?: boolean;
  /** Gives the camera the main area, or hands it back. Offered only while the camera is on. */
  onToggleFocus?: () => void;
  /** Handlers that open the participant's menu (right click, long press). */
  menu?: HTMLAttributes<HTMLDivElement>;
}

/** One participant of a voice channel. The accent outline means "speaking right now". */
export function ParticipantTile({
  name,
  nameColor,
  serverMuted = false,
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
  focused = false,
  onToggleFocus,
  menu,
}: ParticipantTileProps) {
  const status = serverMuted ? 'MUTADO NO SERVIDOR' : deafened ? 'SURDO' : muted ? 'MUDO' : null;
  const containerRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const canFocus = Boolean(video && onToggleFocus);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = () => {
    const container = containerRef.current;
    if (!container) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else if (typeof container.requestFullscreen === 'function') {
      void container.requestFullscreen().catch(() => undefined);
    } else {
      // iPhone browsers only offer fullscreen on the <video> itself, with the native player.
      const player = container.querySelector('video') as
        (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
      player?.webkitEnterFullscreen?.();
    }
  };

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
      data-focused={focused}
      {...menu}
      className={cx(
        'anim-rise group relative flex flex-col border bg-surface transition-colors',
        compact ? 'h-full w-44 shrink-0' : 'h-full w-full',
        menu && 'cursor-pointer',
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
            className={cx(
              'absolute inset-0 h-full w-full',
              // Enlarged, the whole picture shows; in a small tile it fills the frame.
              focused || fullscreen ? 'bg-bg object-contain' : 'object-cover',
              isSelf && '-scale-x-100',
            )}
          />
        )}
        {canFocus && (
          <>
            <button
              type="button"
              aria-label={focused ? `Reduzir a câmera de ${name}` : `Ampliar a câmera de ${name}`}
              title={focused ? 'Dois cliques: tela cheia' : 'Clique para ampliar'}
              className="absolute inset-0 cursor-pointer"
              onClick={focused ? undefined : onToggleFocus}
              onDoubleClick={focused ? toggleFullscreen : undefined}
            />
            {(focused || fullscreen) && (
              <div
                className={cx(
                  'absolute right-0 bottom-0 left-0 flex flex-wrap items-center justify-end gap-px border-t border-line bg-bg',
                  'transition-opacity md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100',
                )}
              >
                <Button className="border-transparent" onClick={toggleFullscreen}>
                  {fullscreen ? 'SAIR DA TELA CHEIA' : 'TELA CHEIA'}
                </Button>
                {!fullscreen && (
                  <Button className="border-transparent" onClick={onToggleFocus}>
                    REDUZIR
                  </Button>
                )}
              </div>
            )}
          </>
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
        {/* Enlarged, the camera is what matters: the watch button stays on the small tiles. */}
        {live && !isSelf && !focused && (
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
        <span className="truncate text-fg" style={nameColor ? { color: nameColor } : undefined}>
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
