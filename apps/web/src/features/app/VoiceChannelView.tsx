import { hasPermission, Permissions, type Channel, type Guild } from '@frequencia/shared';
import { Button } from '../../components/Button';
import { channelPermissions, memberName } from '../guilds/permissions';
import { VoiceControls } from '../voice/components/VoiceControls';
import { VoiceStage } from '../voice/components/VoiceStage';
import { useVoiceStore } from '../voice/voice-store';
import { connectToVoiceChannel } from './voice-channel';

/**
 * Main area for a voice channel: the live stage while connected. Clicking the channel joins
 * it, so the lobby only shows after hanging up, on a direct link or when joining is not allowed.
 */
export function VoiceChannelView({
  guild,
  channel,
  userId,
}: {
  guild: Guild;
  channel: Channel;
  userId: string;
}) {
  const status = useVoiceStore((state) => state.status);
  const connectedChannelId = useVoiceStore((state) => state.channelId);
  const error = useVoiceStore((state) => state.error);
  const permissions = channelPermissions(guild, channel, userId);
  const canConnect = hasPermission(permissions, Permissions.Connect);
  const here = connectedChannelId === channel.id;
  // The stage shows from the first moment of the connection, so joining has no in-between screen.
  const live =
    here && (status === 'connecting' || status === 'connected' || status === 'reconnecting');

  if (live) {
    return (
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1">
          <VoiceStage selfName={memberName(guild, userId)} />
        </div>
        {/* From md up the controls live in the channel column, next to the user. */}
        <div className="shrink-0 border-t border-line bg-surface p-3 md:hidden">
          <VoiceControls canStream={hasPermission(permissions, Permissions.Stream)} />
        </div>
      </div>
    );
  }

  const inChannel = guild.voiceStates.filter((state) => state.channelId === channel.id);
  const connecting = here && status === 'connecting';

  return (
    <div className="grid-bg flex h-full items-center justify-center p-4">
      <section className="anim-rise w-full max-w-sm border border-line bg-surface">
        <header className="border-b border-line px-4 py-4">
          <p className="label text-muted">CANAL DE VOZ</p>
          <h2 className="display mt-1 truncate text-xl text-fg">{channel.name}</h2>
        </header>
        <div className="flex flex-col gap-4 p-4">
          <div>
            <p className="label text-muted">
              {inChannel.length === 0
                ? 'NINGUÉM CONECTADO'
                : `${inChannel.length} ${inChannel.length === 1 ? 'CONECTADO' : 'CONECTADOS'}`}
            </p>
            {inChannel.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1">
                {inChannel.map((voice) => (
                  <li key={voice.userId} className="label-lg flex justify-between gap-2 text-fg">
                    <span className="truncate">{memberName(guild, voice.userId)}</span>
                    {voice.streaming && <span className="label text-accent">AO VIVO</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {status === 'error' && error && (
            <p role="alert" className="label text-danger">
              {error}
            </p>
          )}
          {!canConnect && <p className="label text-danger">VOCÊ NÃO TEM PERMISSÃO PARA CONECTAR</p>}
          <Button
            variant="primary"
            disabled={!canConnect || connecting}
            onClick={() => connectToVoiceChannel(channel)}
          >
            {connecting ? 'CONECTANDO' : 'ENTRAR NO CANAL'}
          </Button>
        </div>
      </section>
    </div>
  );
}
