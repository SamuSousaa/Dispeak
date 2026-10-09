import type { User } from '@frequencia/shared';
import { cx } from '../../lib/cx';
import { logout } from '../auth/auth-store';
import { gateway } from '../gateway/gateway-client';
import { leaveVoice, toggleDeafen, toggleMute } from '../voice/voice-actions';
import { useVoiceStore } from '../voice/voice-store';

const smallButton =
  'label border border-line-strong px-1.5 py-1 transition-colors hover:border-accent hover:text-accent';

/** Bottom of the channel column: the active voice connection and the signed-in user. */
export function UserPanel({ user }: { user: User }) {
  const status = useVoiceStore((state) => state.status);
  const channelName = useVoiceStore((state) => state.channelName);
  const muted = useVoiceStore((state) => state.muted);
  const deafened = useVoiceStore((state) => state.deafened);
  const inVoice = status === 'connected' || status === 'reconnecting' || status === 'connecting';

  const signOut = async () => {
    leaveVoice();
    gateway.stop();
    await logout();
  };

  return (
    <div className="shrink-0 border-t border-line">
      {inVoice && (
        <div className="border-b border-line px-3 py-2" data-testid="voice-panel">
          <p className="label flex items-center justify-between gap-2">
            <span className={status === 'connected' ? 'text-accent' : 'text-danger'}>
              {status === 'connected' ? 'VOZ CONECTADA' : 'CONECTANDO VOZ'}
            </span>
            <span className="truncate text-muted">{channelName}</span>
          </p>
          <div className="mt-2 grid grid-cols-3 gap-1.5">
            <button
              type="button"
              className={cx(smallButton, muted ? 'text-danger' : 'text-fg')}
              aria-pressed={muted}
              aria-label={muted ? 'Ativar microfone' : 'Mutar microfone'}
              title="Mutar microfone (M)"
              onClick={toggleMute}
            >
              {muted ? 'MIC OFF' : 'MIC'}
            </button>
            <button
              type="button"
              className={cx(smallButton, deafened ? 'text-danger' : 'text-fg')}
              aria-pressed={deafened}
              aria-label={deafened ? 'Ativar áudio' : 'Ensurdecer'}
              title="Ensurdecer (D)"
              onClick={toggleDeafen}
            >
              {deafened ? 'SOM OFF' : 'SOM'}
            </button>
            <button
              type="button"
              className={cx(smallButton, 'text-danger')}
              aria-label="Desligar voz"
              onClick={leaveVoice}
            >
              DESLIGAR
            </button>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="min-w-0">
          <p className="label-lg truncate text-fg">{user.displayName}</p>
          <p className="label truncate text-muted">@{user.username}</p>
        </div>
        <button
          type="button"
          className="label shrink-0 text-muted transition-colors hover:text-accent"
          onClick={() => void signOut()}
        >
          [ SAIR ]
        </button>
      </div>
    </div>
  );
}
