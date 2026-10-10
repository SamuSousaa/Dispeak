import { Button } from '../../../components/Button';
import { useKeybind } from '../../settings/settings-store';
import { leaveVoice, toggleDeafen, toggleMute } from '../voice-actions';
import { useVoiceStore } from '../voice-store';
import { ScreenShareButton } from './ScreenShareButton';

const withKey = (text: string, binding: string | null) => (binding ? `${text} (${binding})` : text);

/** Mute, deafen, share and leave, as a row of buttons. */
export function VoiceControls({
  onLeave,
  canStream = true,
}: {
  onLeave?: () => void;
  /** Whether the user may share their screen in this channel. */
  canStream?: boolean;
}) {
  const muted = useVoiceStore((state) => state.muted);
  const deafened = useVoiceStore((state) => state.deafened);
  const micAvailable = useVoiceStore((state) => state.micAvailable);
  const muteKey = useKeybind('mute');
  const deafenKey = useKeybind('deafen');

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant={muted ? 'danger' : 'default'}
        aria-pressed={muted}
        aria-keyshortcuts={muteKey ?? undefined}
        title={withKey('Mutar microfone', muteKey)}
        onClick={toggleMute}
      >
        {muted ? 'MUTADO' : 'MUTAR'}
      </Button>
      <Button
        variant={deafened ? 'danger' : 'default'}
        aria-pressed={deafened}
        aria-keyshortcuts={deafenKey ?? undefined}
        title={withKey('Ensurdecer', deafenKey)}
        onClick={toggleDeafen}
      >
        {deafened ? 'ENSURDECIDO' : 'ENSURDECER'}
      </Button>
      <ScreenShareButton allowed={canStream} />
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
