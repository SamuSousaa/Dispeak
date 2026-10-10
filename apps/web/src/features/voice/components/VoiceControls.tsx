import { Button } from '../../../components/Button';
import { useKeybind } from '../../settings/settings-store';
import { leaveVoice, toggleCamera, toggleDeafen, toggleMute } from '../voice-actions';
import { useVoiceStore } from '../voice-store';
import { MicMeter } from './MicMeter';
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
  const camera = useVoiceStore((state) => state.camera);
  const connected = useVoiceStore((state) => state.status === 'connected');
  const muteKey = useKeybind('mute');
  const deafenKey = useKeybind('deafen');

  return (
    <div className="flex flex-wrap items-center gap-2">
      <MicMeter className="basis-full" />
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
      <Button
        variant={camera.status === 'live' ? 'active' : 'default'}
        aria-pressed={camera.status === 'live'}
        disabled={!canStream || !connected || camera.status === 'starting'}
        title={canStream ? undefined : 'Você não tem permissão para ligar a câmera neste canal'}
        onClick={toggleCamera}
      >
        {camera.status === 'live' ? 'DESLIGAR CÂMERA' : 'CÂMERA'}
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
      {camera.error && (
        <span role="alert" className="label text-danger">
          {camera.error}
        </span>
      )}
      {!micAvailable && (
        <span role="status" className="label text-danger">
          SEM MICROFONE — SOMENTE ESCUTA
        </span>
      )}
    </div>
  );
}
