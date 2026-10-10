import { hasPermission, Permissions, type Channel, type Guild } from '@frequencia/shared';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { cx } from '../../lib/cx';
import { channelPermissions, memberName } from '../guilds/permissions';
import { useChannelUnread } from '../unread/unread-store';
import { VoiceControls } from '../voice/components/VoiceControls';
import { VoiceStage } from '../voice/components/VoiceStage';
import { useVoiceStore } from '../voice/voice-store';
import { TextChannelView } from './TextChannelView';
import { toggleSideChat, useUiStore } from './ui-store';
import { connectToVoiceChannel } from './voice-channel';

/** Opens and closes the channel's own text chat; shows when something there is unread. */
function ChatToggle({ channel, open }: { channel: Channel; open: boolean }) {
  const unread = useChannelUnread(channel.id);
  return (
    <button
      type="button"
      data-testid="voice-chat-toggle"
      aria-pressed={open}
      aria-label={open ? 'Fechar chat do canal' : 'Abrir chat do canal'}
      title={open ? 'Fechar chat do canal' : 'Abrir chat do canal'}
      onClick={toggleSideChat}
      className={cx(
        'pressable absolute top-3 right-3 z-10 inline-flex h-9 items-center gap-1.5 border bg-bg px-2',
        open
          ? 'border-accent text-accent'
          : 'border-line-strong text-fg hover:border-accent hover:text-accent',
      )}
    >
      <Icon name="chat" />
      {!open && unread && (
        <span className="label bg-fg px-1 text-bg">
          {unread.mentions > 0 ? unread.mentions : unread.count > 99 ? '99+' : unread.count}
        </span>
      )}
    </button>
  );
}

/** The text chat every voice channel has, docked next to the call. */
function VoiceChat({ guild, channel, userId }: { guild: Guild; channel: Channel; userId: string }) {
  return (
    <aside
      data-testid="side-chat"
      aria-label={`Chat de ${channel.name}`}
      className="anim-fade flex h-1/2 min-h-0 shrink-0 flex-col border-t border-line md:h-auto md:w-80 md:border-t-0 md:border-l xl:w-96"
    >
      <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-line bg-surface px-3">
        <h2 className="label truncate text-muted">
          CHAT DE <span className="text-fg">{channel.name}</span>
        </h2>
        <button
          type="button"
          aria-label="Fechar chat"
          className="label shrink-0 text-muted transition-colors hover:text-accent"
          onClick={toggleSideChat}
        >
          [ X ]
        </button>
      </header>
      <div className="min-h-0 flex-1">
        <TextChannelView key={channel.id} guild={guild} channel={channel} userId={userId} />
      </div>
    </aside>
  );
}

/**
 * Main area for a voice channel: the live stage while connected. Clicking the channel joins
 * it, so the lobby only shows after hanging up, on a direct link or when joining is not allowed.
 * Either way the channel's text chat can be opened beside it.
 */
export function VoiceChannelView({
  guild,
  channel,
  userId,
  onManageMembers,
}: {
  guild: Guild;
  channel: Channel;
  userId: string;
  onManageMembers?: () => void;
}) {
  const status = useVoiceStore((state) => state.status);
  const connectedChannelId = useVoiceStore((state) => state.channelId);
  const error = useVoiceStore((state) => state.error);
  const sideChatOpen = useUiStore((state) => state.sideChatOpen);
  const permissions = channelPermissions(guild, channel, userId);
  const canConnect = hasPermission(permissions, Permissions.Connect);
  const here = connectedChannelId === channel.id;
  // The stage shows from the first moment of the connection, so joining has no in-between screen.
  const live =
    here && (status === 'connecting' || status === 'connected' || status === 'reconnecting');

  const inChannel = guild.voiceStates.filter((state) => state.channelId === channel.id);
  const connecting = here && status === 'connecting';

  return (
    <div className="flex h-full flex-col md:flex-row">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <ChatToggle channel={channel} open={sideChatOpen} />
        {live ? (
          <>
            <div className="min-h-0 flex-1">
              <VoiceStage guild={guild} userId={userId} onManageMembers={onManageMembers} />
            </div>
            {/* From md up the controls live in the channel column, next to the user. */}
            <div className="shrink-0 border-t border-line bg-surface p-3 md:hidden">
              <VoiceControls canStream={hasPermission(permissions, Permissions.Stream)} />
            </div>
          </>
        ) : (
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
                        <li
                          key={voice.userId}
                          className="label-lg flex justify-between gap-2 text-fg"
                        >
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
                {!canConnect && (
                  <p className="label text-danger">VOCÊ NÃO TEM PERMISSÃO PARA CONECTAR</p>
                )}
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
        )}
      </div>
      {sideChatOpen && <VoiceChat guild={guild} channel={channel} userId={userId} />}
    </div>
  );
}
