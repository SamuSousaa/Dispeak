import { cx } from '../../../lib/cx';
import { useSettingsStore } from '../../settings/settings-store';
import { useVoiceStore } from '../voice-store';

const SEGMENTS = 8;

/** A row of segments that light up with the level (0 to 1). */
export function LevelBar({ level, className }: { level: number; className?: string }) {
  const lit = Math.round(Math.min(1, Math.max(0, level)) * SEGMENTS);
  return (
    <span
      role="meter"
      aria-label="Nível do microfone"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(level * 100)}
      data-testid="mic-level"
      className={cx('flex h-2.5 shrink-0 gap-px', className)}
    >
      {Array.from({ length: SEGMENTS }, (_, index) => (
        <span
          key={index}
          className={cx('h-full w-1.5', index < lit ? 'bg-accent' : 'bg-line-strong')}
        />
      ))}
    </span>
  );
}

/**
 * Shows the user that their voice is going out: the level of the very audio the others
 * receive, after noise suppression. Flat while muted or while the push-to-talk key is up,
 * since nothing is sent then.
 */
export function MicMeter({ className }: { className?: string }) {
  const level = useVoiceStore((state) => state.micLevel);
  const selfMuted = useVoiceStore((state) => state.muted);
  const pttHeld = useVoiceStore((state) => state.pttHeld);
  const pushToTalk = useSettingsStore((state) => state.inputMode === 'pushToTalk');
  const muted = selfMuted || (pushToTalk && !pttHeld);
  const micAvailable = useVoiceStore((state) => state.micAvailable);
  const connected = useVoiceStore((state) => state.status === 'connected');
  if (!micAvailable || !connected) return null;
  const sending = !muted && level > 0;

  return (
    <div
      className={cx('flex items-center gap-2', className)}
      title="Nível do que os outros ouvem de você, já com a supressão de ruído"
    >
      <span className="label text-muted">MIC</span>
      <LevelBar level={muted ? 0 : level} />
      <span className={cx('label', sending ? 'text-accent' : 'text-muted')}>
        {selfMuted ? 'MUTADO' : muted ? 'FECHADO' : sending ? 'ENVIANDO' : 'SILÊNCIO'}
      </span>
    </div>
  );
}
