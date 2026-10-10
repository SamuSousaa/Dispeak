import { SIMULCAST_LAYERS } from '@frequencia/shared';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/Button';
import { IconButton } from '../../../components/IconButton';
import { MediaVideo } from '../../../components/MediaVideo';
import { cx } from '../../../lib/cx';
import { registerStreamFullscreen } from '../stream-fullscreen';
import { setStreamViewport, setStreamVolume } from '../voice-actions';
import { SELF_STREAM, useVoiceStore, type StreamStats } from '../voice-store';
import { LiveBadge } from './LiveBadge';
import { volumeIsFixed } from './VolumeControl';

interface IosVideoElement extends HTMLVideoElement {
  webkitEnterFullscreen?: () => void;
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
}

/** A small always-on-top window with the video, so the stream follows the user around. */
const supportsPip =
  typeof document !== 'undefined' &&
  (document.pictureInPictureEnabled || 'webkitSetPresentationMode' in HTMLVideoElement.prototype);

interface StreamTileProps {
  /** Streamer session id, or `SELF_STREAM` for the local preview. */
  id: string;
  name: string;
  stream: MediaStream | null;
  /** Whether the streamer sends the sound of what they share. */
  hasAudio?: boolean;
  focused: boolean;
  /** Thumbnail rendition shown next to a focused stream. */
  compact?: boolean;
  onToggleFocus: () => void;
  /** Stop watching (or stop sharing, for the local preview). */
  onClose: () => void;
}

const dash = (value: number | string | null | undefined, unit = '') =>
  value === null || value === undefined ? '—' : `${value}${unit}`;

function StatsPanel({ id, stats }: { id: string; stats: StreamStats | undefined }) {
  const rttMs = useVoiceStore((state) => state.stats.rttMs);
  const layer = useVoiceStore((state) => state.watching[id]?.spatialLayer ?? null);
  const isSelf = id === SELF_STREAM;

  const rows: Array<[string, string]> = [
    ['RESOLUÇÃO', stats?.width && stats.height ? `${stats.width}×${stats.height}` : '—'],
    ['FPS', dash(stats?.fps)],
    ['BITRATE', dash(stats?.kbps, ' KBPS')],
    ['RTT', dash(rttMs, ' MS')],
    ['CODEC', dash(stats?.codec?.toUpperCase())],
  ];
  if (isSelf) {
    rows.push(['LIMITAÇÃO', dash(stats?.limitation?.toUpperCase() ?? 'NENHUMA')]);
    for (const item of stats?.layers ?? []) {
      rows.push([
        `CAMADA ${item.rid.toUpperCase()}`,
        item.fps
          ? `${dash(item.height)}P · ${dash(item.fps)} FPS · ${dash(item.kbps, ' KBPS')}`
          : 'INATIVA',
      ]);
    }
  } else {
    rows.splice(3, 0, ['PERDA', dash(stats?.lossPercent, '%')]);
    rows.push(['CAMADA', layer === null ? '—' : `${layer + 1}/${SIMULCAST_LAYERS}`]);
  }

  return (
    <dl
      data-testid="stream-stats"
      className="label absolute bottom-8 left-0 grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 border border-line bg-bg px-3 py-2"
    >
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd className="text-fg" data-stat={label}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Sound of one stream, for this viewer only: silence it or turn it down. */
function StreamVolume({ id, name }: { id: string; name: string }) {
  const volume = useVoiceStore((state) => state.streamVolumes[id] ?? 1);
  // What to go back to when the sound is turned on again.
  const before = useRef(1);
  const silent = volume === 0;
  return (
    <div className="mr-auto flex items-center gap-2 pl-1" data-testid="stream-volume">
      <IconButton
        icon={silent ? 'volume-off' : 'volume'}
        tone={silent ? 'danger' : 'default'}
        label={silent ? 'Ativar som da transmissão' : 'Silenciar transmissão'}
        aria-pressed={silent}
        className="border-transparent"
        onClick={() => {
          if (!silent) before.current = volume;
          setStreamVolume(id, silent ? before.current || 1 : 0);
        }}
      />
      {!volumeIsFixed && (
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          aria-label={`Volume da transmissão de ${name}`}
          title={`Volume: ${Math.round(volume * 100)}%`}
          className="w-24 accent-(--accent)"
          onChange={(event) => setStreamVolume(id, Number(event.target.value))}
        />
      )}
      <span className="label w-9 text-muted">{Math.round(volume * 100)}%</span>
    </div>
  );
}

/** A live screen share: the video plus sound, focus, fullscreen and statistics controls. */
export function StreamTile({
  id,
  name,
  stream,
  hasAudio = false,
  focused,
  compact = false,
  onToggleFocus,
  onClose,
}: StreamTileProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [showStats, setShowStats] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [floating, setFloating] = useState(false);
  const stats = useVoiceStore((state) => state.streamStats[id]);
  const isSelf = id === SELF_STREAM;

  // The displayed size drives which simulcast layer the server forwards to this viewer.
  useEffect(() => {
    const element = containerRef.current;
    if (!element || isSelf) return;
    let timer: number | undefined;
    const report = () => setStreamViewport(id, element.clientHeight);
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
  }, [id, isSelf]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const enterFullscreen = () => {
    const container = containerRef.current;
    if (!container) return;
    if (typeof container.requestFullscreen === 'function') {
      void container.requestFullscreen().catch(() => undefined);
      return;
    }
    // iPhone browsers only offer fullscreen on the <video> itself, with the native player.
    const video = container.querySelector('video') as IosVideoElement | null;
    video?.webkitEnterFullscreen?.();
  };

  // The floating window can also be closed from its own controls.
  useEffect(() => {
    const video = containerRef.current?.querySelector('video');
    if (!video) return;
    const onEnter = () => setFloating(true);
    const onLeave = () => setFloating(false);
    video.addEventListener('enterpictureinpicture', onEnter);
    video.addEventListener('leavepictureinpicture', onLeave);
    return () => {
      video.removeEventListener('enterpictureinpicture', onEnter);
      video.removeEventListener('leavepictureinpicture', onLeave);
      // Leaving the tile (stopped watching, left the call) takes its window along.
      if (document.pictureInPictureElement === video) {
        void document.exitPictureInPicture().catch(() => undefined);
      }
    };
  }, []);

  const toggleFloating = () => {
    const video = containerRef.current?.querySelector('video') as IosVideoElement | null;
    if (!video) return;
    if (typeof video.requestPictureInPicture === 'function') {
      if (document.pictureInPictureElement === video) {
        void document.exitPictureInPicture().catch(() => undefined);
      } else {
        void video.requestPictureInPicture().catch(() => undefined);
      }
      return;
    }
    // iPhone and iPad.
    if (video.webkitSupportsPresentationMode?.('picture-in-picture')) {
      const next =
        video.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture';
      video.webkitSetPresentationMode?.(next);
      setFloating(next !== 'inline');
    }
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else enterFullscreen();
  };

  // Thumbnails are left out: the fullscreen shortcut targets the streams being watched.
  useEffect(() => {
    if (compact) return;
    return registerStreamFullscreen(id, {
      focused,
      toggle: enterFullscreen,
    });
  }, [id, compact, focused]);

  return (
    <div
      ref={containerRef}
      data-testid="stream-tile"
      data-stream={isSelf ? 'self' : name}
      className={cx(
        'anim-rise group relative h-full min-h-0 w-full overflow-hidden border bg-bg',
        focused ? 'border-accent' : 'border-line',
      )}
    >
      <MediaVideo
        stream={stream}
        muted
        data-testid="stream-video"
        className="h-full w-full object-contain"
        onDoubleClick={toggleFullscreen}
      />
      {!stream && (
        <div className="label absolute inset-0 flex items-center justify-center text-muted">
          CARREGANDO TRANSMISSÃO
        </div>
      )}

      <div className="absolute top-0 left-0 flex max-w-full items-center">
        <LiveBadge />
        <span className="label truncate border-r border-b border-line bg-bg px-2 py-0.5 text-fg">
          {isSelf ? 'SUA TRANSMISSÃO' : name}
        </span>
      </div>

      {compact ? (
        <button
          type="button"
          aria-label={`Focar na transmissão de ${name}`}
          className="absolute inset-0"
          onClick={onToggleFocus}
        />
      ) : (
        <>
          {showStats && <StatsPanel id={id} stats={stats} />}
          <div
            className={cx(
              'absolute right-0 bottom-0 left-0 flex flex-wrap items-center justify-end gap-px border-t border-line bg-bg',
              // Always visible on touch devices and while anything inside has focus.
              'transition-opacity md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100',
              (showStats || fullscreen) && 'md:opacity-100',
            )}
          >
            {!isSelf &&
              (hasAudio ? (
                <StreamVolume id={id} name={name} />
              ) : (
                <span className="label mr-auto px-3 text-muted">SEM ÁUDIO</span>
              ))}
            <Button
              className="border-transparent"
              variant={showStats ? 'active' : 'default'}
              aria-pressed={showStats}
              onClick={() => setShowStats((value) => !value)}
            >
              STATS
            </Button>
            <Button
              className="border-transparent"
              variant={focused ? 'active' : 'default'}
              aria-pressed={focused}
              onClick={onToggleFocus}
            >
              {focused ? 'GRADE' : 'FOCO'}
            </Button>
            {supportsPip && (
              <Button
                className="border-transparent"
                variant={floating ? 'active' : 'default'}
                aria-pressed={floating}
                title="Mantém o vídeo numa janela pequena por cima de tudo"
                onClick={toggleFloating}
              >
                {floating ? 'FECHAR JANELA' : 'JANELA FLUTUANTE'}
              </Button>
            )}
            <Button className="border-transparent" onClick={toggleFullscreen}>
              {fullscreen ? 'SAIR DA TELA CHEIA' : 'TELA CHEIA'}
            </Button>
            <Button className="border-transparent" variant="danger" onClick={onClose}>
              {isSelf ? 'PARAR TRANSMISSÃO' : 'PARAR DE ASSISTIR'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
