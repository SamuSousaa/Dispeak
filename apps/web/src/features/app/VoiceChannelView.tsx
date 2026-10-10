import { hasPermission, Permissions, type Channel, type Guild } from '@frequencia/shared';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { channelPermissions, groupChannels, memberName } from '../guilds/permissions';
import { VoiceControls } from '../voice/components/VoiceControls';
import { VoiceStage } from '../voice/components/VoiceStage';
import { useVoiceStore } from '../voice/voice-store';
import { TextChannelView } from './TextChannelView';
import { toggleSideChat, useUiStore } from './ui-store';
import { connectToVoiceChannel } from './voice-channel';

/** A text channel docked next to the call, so links and memes do not mean leaving the stream. */
function SideChat({ guild, userId }: { guild: Guild; userId: string }) {
  const remembered = useUiStore((state) => state.lastTextChannel[guild.id]);
  const [chosen, setChosen] = useState<string | null>(null);
  const options = groupChannels(guild)
    .flatMap((group) => group.channels)
    .filter((entry) => entry.channel.type === 'text');
  const current =
    options.find((entry) => entry.channel.id === (chosen ?? remembered)) ?? options[0];
  if (!current) return null;

  return (
    <aside
      data-testid="side-chat"
      aria-label="Chat ao lado da chamada"
      className="anim-fade flex h-1/2 min-h-0 shrink-0 flex-col border-t border-line md:h-auto md:w-80 md:border-t-0 md:border-l xl:w-96"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-surface px-2">
        <select
          className="field h-7 min-w-0 flex-1 px-1.5 uppercase"
          aria-label="Canal de texto"
          value={current.channel.id}
          onChange={(event) => setChosen(event.target.value)}
        >
          {options.map(({ channel, number }) => (
            <option key={channel.id} value={channel.id}>
              {number}. {channel.name}
            </option>
          ))}
        </select>
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
        <TextChannelView
          key={current.channel.id}
          guild={guild}
          channel={current.channel}
          userId={userId}
        />
      </div>
    </aside>
  );
}

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
  const sideChatOpen = useUiStore((state) => state.sideChatOpen);
  const permissions = channelPermissions(guild, channel, userId);
  const canConnect = hasPermission(permissions, Permissions.Connect);
  const here = connectedChannelId === channel.id;
  // The stage shows from the first moment of the connection, so joining has no in-between screen.
  const live =
    here && (status === 'connecting' || status === 'connected' || status === 'reconnecting');

  if (live) {
    return (
      <div className="flex h-full flex-col md:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <VoiceStage selfName={memberName(guild, userId)} />
          </div>
          {/* From md up the controls live in the channel column, next to the user. */}
          <div className="shrink-0 border-t border-line bg-surface p-3 md:hidden">
            <VoiceControls canStream={hasPermission(permissions, Permissions.Stream)} />
          </div>
        </div>
        {sideChatOpen && <SideChat guild={guild} userId={userId} />}
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
