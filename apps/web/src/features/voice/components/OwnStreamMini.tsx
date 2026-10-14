import { useState } from 'react';
import { Link } from 'react-router-dom';
import { IconButton } from '../../../components/IconButton';
import { MediaVideo } from '../../../components/MediaVideo';
import { SELF_STREAM, useVoiceStore } from '../voice-store';
import { LiveBadge } from './LiveBadge';

/**
 * The streamer's own stream in a corner of the app while they look at something other than the
 * call: what they are sending stays in sight. Clicking it goes back to the call; it folds down
 * to a strip when it is in the way.
 */
export function OwnStreamMini({ to }: { to: string | null }) {
  const screen = useVoiceStore((state) => state.screen);
  const stats = useVoiceStore((state) => state.streamStats[SELF_STREAM]);
  const [folded, setFolded] = useState(false);
  if (screen.status !== 'live') return null;

  const numbers = [
    stats?.fps !== null && stats?.fps !== undefined ? `${stats.fps} FPS` : null,
    stats?.kbps ? `${(stats.kbps / 1000).toFixed(1)} MBPS` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <aside
      aria-label="Sua transmissão"
      data-testid="own-stream-mini"
      className="anim-view absolute top-15 right-3 z-20 hidden w-72 border border-line bg-surface md:block"
    >
      <div className="flex items-center gap-2 border-b border-line">
        <LiveBadge />
        <span className="label min-w-0 flex-1 truncate text-fg">SUA TRANSMISSÃO</span>
        {numbers && <span className="label shrink-0 text-muted tabular-nums">{numbers}</span>}
        <IconButton
          icon={folded ? 'chevron-up' : 'chevron-down'}
          label={folded ? 'Mostrar prévia' : 'Recolher prévia'}
          className="border-0"
          onClick={() => setFolded((value) => !value)}
          aria-expanded={!folded}
        />
      </div>
      {!folded && (
        <Link
          to={to ?? '#'}
          aria-label="Voltar para a chamada"
          className="block aspect-video bg-bg focus-visible:outline-accent"
        >
          {screen.stream ? (
            <MediaVideo
              stream={screen.stream}
              muted
              data-testid="own-stream-mini-video"
              className="h-full w-full object-contain"
            />
          ) : (
            <span className="label flex h-full items-center justify-center text-muted">
              SEM PRÉVIA
            </span>
          )}
        </Link>
      )}
    </aside>
  );
}
