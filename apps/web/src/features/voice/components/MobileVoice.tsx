import { NavLink } from 'react-router-dom';
import { IconButton } from '../../../components/IconButton';
import { leaveVoice, toggleCamera, toggleDeafen, toggleMute } from '../voice-actions';
import { useVoiceStore } from '../voice-store';
import { MicMeter } from './MicMeter';
import { ScreenShareButton } from './ScreenShareButton';

/** Phones cannot capture their screen from a web page; the button would only fail. */
const canShareScreen =
  typeof navigator !== 'undefined' &&
  typeof navigator.mediaDevices?.getDisplayMedia === 'function' &&
  !window.matchMedia('(hover: none) and (pointer: coarse)').matches;

const BIG = 'h-12 w-12';

/** The call controls as a row of large buttons, for the bottom of a phone screen. */
export function MobileVoiceControls({ canStream }: { canStream: boolean }) {
  const muted = useVoiceStore((state) => state.muted);
  const deafened = useVoiceStore((state) => state.deafened);
  const micAvailable = useVoiceStore((state) => state.micAvailable);
  const camera = useVoiceStore((state) => state.camera);
  const connected = useVoiceStore((state) => state.status === 'connected');

  return (
    <div className="flex flex-col gap-2">
      <MicMeter className="justify-center" />
      <div className="flex items-center justify-center gap-3">
        <IconButton
          icon={muted ? 'mic-off' : 'mic'}
          tone={muted ? 'danger' : 'default'}
          label={muted ? 'Ativar microfone' : 'Mutar microfone'}
          aria-pressed={muted}
          className={BIG}
          onClick={toggleMute}
        />
        <IconButton
          icon={deafened ? 'headphones-off' : 'headphones'}
          tone={deafened ? 'danger' : 'default'}
          label={deafened ? 'Ativar áudio' : 'Ensurdecer'}
          aria-pressed={deafened}
          className={BIG}
          onClick={toggleDeafen}
        />
        <IconButton
          icon={camera.status === 'live' ? 'camera' : 'camera-off'}
          tone={camera.status === 'live' ? 'active' : 'default'}
          label={camera.status === 'live' ? 'Desligar câmera' : 'Ligar câmera'}
          aria-pressed={camera.status === 'live'}
          className={BIG}
          disabled={!canStream || !connected || camera.status === 'starting'}
          onClick={toggleCamera}
        />
        {canShareScreen && <ScreenShareButton allowed={canStream} />}
        <IconButton
          icon="hang-up"
          tone="danger"
          label="Desligar voz"
          className={BIG}
          onClick={leaveVoice}
        />
      </div>
      {camera.error && (
        <p role="alert" className="label text-center text-danger">
          {camera.error}
        </p>
      )}
      {!micAvailable && (
        <p role="status" className="label text-center text-danger">
          SEM MICROFONE — SOMENTE ESCUTA
        </p>
      )}
    </div>
  );
}

/**
 * On a phone the channel column is a drawer, so an ongoing call would be out of sight while
 * reading a chat. This strip keeps it at hand: where the call is, mute and hang up.
 */
export function MobileVoiceBar({ to, channelName }: { to: string | null; channelName: string }) {
  const status = useVoiceStore((state) => state.status);
  const muted = useVoiceStore((state) => state.muted);

  return (
    <div
      data-testid="mobile-voice-bar"
      className="flex shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-3 py-1.5 md:hidden"
    >
      {to ? (
        <NavLink to={to} className="min-w-0 flex-1">
          <span className={status === 'connected' ? 'label text-accent' : 'label text-danger'}>
            {status === 'connected' ? 'EM CHAMADA' : 'RECONECTANDO'}
          </span>
          <span className="label block truncate text-muted">{channelName} · TOQUE PARA VOLTAR</span>
        </NavLink>
      ) : (
        <span className="label min-w-0 flex-1 truncate text-accent">
          EM CHAMADA · {channelName}
        </span>
      )}
      <IconButton
        icon={muted ? 'mic-off' : 'mic'}
        tone={muted ? 'danger' : 'default'}
        label={muted ? 'Ativar microfone' : 'Mutar microfone'}
        aria-pressed={muted}
        className="h-10 w-10"
        onClick={toggleMute}
      />
      <IconButton
        icon="hang-up"
        tone="danger"
        label="Desligar voz"
        className="h-10 w-10"
        onClick={leaveVoice}
      />
    </div>
  );
}
