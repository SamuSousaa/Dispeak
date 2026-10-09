import { Button } from '../../../components/Button';
import { leaveVoice, toggleDeafen, toggleMute } from '../voice-actions';
import { useVoiceStore } from '../voice-store';

/** Mute, deafen and leave. Shortcuts: M and D (or Ctrl+Shift+M / Ctrl+Shift+D). */
export function VoiceControls({ onLeave }: { onLeave?: () => void }) {
  const muted = useVoiceStore((state) => state.muted);
  const deafened = useVoiceStore((state) => state.deafened);
  const micAvailable = useVoiceStore((state) => state.micAvailable);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant={muted ? 'danger' : 'default'}
        aria-pressed={muted}
        aria-keyshortcuts="M Control+Shift+M"
        title="Mutar microfone (M)"
        onClick={toggleMute}
      >
        {muted ? 'MUTADO' : 'MUTAR'}
      </Button>
      <Button
        variant={deafened ? 'danger' : 'default'}
        aria-pressed={deafened}
        aria-keyshortcuts="D Control+Shift+D"
        title="Ensurdecer (D)"
        onClick={toggleDeafen}
      >
        {deafened ? 'ENSURDECIDO' : 'ENSURDECER'}
      </Button>
      <Button
        variant="danger"
        onClick={() => {
          leaveVoice();
          onLeave?.();
        }}
      >
        SAIR
      </Button>
      {!micAvailable && (
        <span role="status" className="label text-danger">
          SEM MICROFONE — SOMENTE ESCUTA
        </span>
      )}
    </div>
  );
}
