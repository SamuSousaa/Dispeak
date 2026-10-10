import { hasPermission, Permissions, type User } from '@frequencia/shared';
import { NavLink } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { IconButton } from '../../components/IconButton';
import { useGatewayStore } from '../gateway/gateway-store';
import { channelPermissions } from '../guilds/permissions';
import { useKeybind, useSettingsStore } from '../settings/settings-store';
import { ScreenShareButton } from '../voice/components/ScreenShareButton';
import { leaveVoice, toggleCamera, toggleDeafen, toggleMute } from '../voice/voice-actions';
import { useVoiceStore } from '../voice/voice-store';

const withKey = (text: string, binding: string | null) => (binding ? `${text} (${binding})` : text);

/**
 * Bottom of the channel column, the control panel of the app: the active voice connection
 * (status, channel, screen share, hang up) and, below it, the user with the microphone,
 * headphones and settings buttons. It stays put while the user browses other channels.
 */
export function UserPanel({ user, onOpenSettings }: { user: User; onOpenSettings: () => void }) {
  const status = useVoiceStore((state) => state.status);
  const channelId = useVoiceStore((state) => state.channelId);
  const channelName = useVoiceStore((state) => state.channelName);
  const muted = useVoiceStore((state) => state.muted);
  const deafened = useVoiceStore((state) => state.deafened);
  const micAvailable = useVoiceStore((state) => state.micAvailable);
  const camera = useVoiceStore((state) => state.camera);
  const rttMs = useVoiceStore((state) => state.stats.rttMs);
  const muteKey = useKeybind('mute');
  const deafenKey = useKeybind('deafen');
  const leaveKey = useKeybind('leave');
  const cameraKey = useKeybind('camera');
  const talkKey = useKeybind('pushToTalk');
  const pushToTalk = useSettingsStore((state) => state.inputMode === 'pushToTalk');
  const pttHeld = useVoiceStore((state) => state.pttHeld);
  // The voice channel may belong to a server other than the one on screen.
  const guild = useGatewayStore((state) =>
    Object.values(state.guilds).find((entry) =>
      entry.channels.some((channel) => channel.id === channelId),
    ),
  );
  const channel = guild?.channels.find((entry) => entry.id === channelId);

  const inVoice = status === 'connected' || status === 'reconnecting' || status === 'connecting';
  const live = status === 'connected' || status === 'reconnecting';
  const canStream =
    guild && channel
      ? hasPermission(channelPermissions(guild, channel, user.id), Permissions.Stream)
      : false;

  return (
    <div className="shrink-0 border-t border-line bg-surface">
      {inVoice && (
        <div className="anim-pop border-b border-line" data-testid="voice-panel">
          <div className="flex items-center gap-2 px-3 pt-2">
            <div className="min-w-0 flex-1">
              <p className="label flex items-baseline gap-2">
                <span className={status === 'connected' ? 'text-accent' : 'text-danger'}>
                  {status === 'connected'
                    ? 'VOZ CONECTADA'
                    : status === 'reconnecting'
                      ? 'RECONECTANDO'
                      : 'CONECTANDO VOZ'}
                </span>
                {status === 'connected' && rttMs !== null && (
                  <span className="text-muted">{rttMs} MS</span>
                )}
              </p>
              {guild && channel ? (
                <NavLink
                  to={`/app/${guild.id}/${channel.id}`}
                  title="Voltar para o canal de voz"
                  className="label block truncate text-muted transition-colors hover:text-accent"
                >
                  {channel.name} / {guild.name}
                </NavLink>
              ) : (
                <p className="label truncate text-muted">{channelName}</p>
              )}
            </div>
            <IconButton
              icon="hang-up"
              tone="danger"
              label="Desligar voz"
              title={withKey('Desligar voz', leaveKey)}
              onClick={leaveVoice}
            />
          </div>
          <div className="px-3 py-2">
            {live && (
              <div className="flex items-start gap-1.5">
                <IconButton
                  icon={camera.status === 'live' ? 'camera' : 'camera-off'}
                  tone={camera.status === 'live' ? 'active' : 'default'}
                  label={camera.status === 'live' ? 'Desligar câmera' : 'Ligar câmera'}
                  title={
                    canStream
                      ? withKey(
                          camera.status === 'live' ? 'Desligar câmera' : 'Ligar câmera',
                          cameraKey,
                        )
                      : 'Você não tem permissão para ligar a câmera neste canal'
                  }
                  aria-pressed={camera.status === 'live'}
                  disabled={!canStream || status !== 'connected' || camera.status === 'starting'}
                  onClick={toggleCamera}
                />
                <ScreenShareButton allowed={canStream} />
              </div>
            )}
            {camera.error && (
              <p role="alert" className="label mt-1.5 text-danger">
                {camera.error}
              </p>
            )}
            {live && pushToTalk && micAvailable && !muted && (
              <p
                role="status"
                data-testid="ptt-status"
                className={`label mt-1.5 ${pttHeld ? 'text-accent' : talkKey ? 'text-muted' : 'text-danger'}`}
              >
                {pttHeld
                  ? 'TRANSMITINDO'
                  : talkKey
                    ? `SEGURE ${talkKey} PARA FALAR`
                    : 'APERTAR PARA FALAR SEM TECLA — DEFINA EM CONFIGURAÇÕES'}
              </p>
            )}
            {!micAvailable && (
              <p role="status" className="label mt-1.5 text-danger">
                SEM MICROFONE — SOMENTE ESCUTA
              </p>
            )}
          </div>
        </div>
      )}
      <div className="flex items-center gap-1.5 px-3 py-2">
        <Avatar name={user.displayName} picture={user.avatar} size={32} />
        <div className="min-w-0 flex-1">
          <p className="label-lg truncate text-fg">{user.displayName}</p>
          <p className="label truncate text-muted">@{user.username}</p>
        </div>
        <IconButton
          icon={muted ? 'mic-off' : 'mic'}
          tone={muted ? 'danger' : 'default'}
          label={muted ? 'Ativar microfone' : 'Mutar microfone'}
          title={
            inVoice
              ? withKey(muted ? 'Ativar microfone' : 'Mutar microfone', muteKey)
              : 'Entre em um canal de voz para usar o microfone'
          }
          aria-pressed={muted}
          disabled={!inVoice}
          onClick={toggleMute}
        />
        <IconButton
          icon={deafened ? 'headphones-off' : 'headphones'}
          tone={deafened ? 'danger' : 'default'}
          label={deafened ? 'Ativar áudio' : 'Ensurdecer'}
          title={
            inVoice
              ? withKey(deafened ? 'Ativar áudio' : 'Ensurdecer', deafenKey)
              : 'Entre em um canal de voz para usar o áudio'
          }
          aria-pressed={deafened}
          disabled={!inVoice}
          onClick={toggleDeafen}
        />
        <IconButton icon="settings" label="Configurações" onClick={onOpenSettings} />
      </div>
    </div>
  );
}
