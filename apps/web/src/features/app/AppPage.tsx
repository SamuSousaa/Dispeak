import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '../../components/Button';
import { ContextMenuHost } from '../../components/ContextMenu';
import { ToastHost } from '../../components/Toast';
import { cx } from '../../lib/cx';
import { logout, useAuthStore } from '../auth/auth-store';
import { releaseAttachmentUrls } from '../chat/Attachments';
import { applyChatEvent } from '../chat/chat-store';
import { gateway } from '../gateway/gateway-client';
import { useGatewayStore } from '../gateway/gateway-store';
import { AddGuildDialog } from '../guilds/dialogs/AddGuildDialog';
import { ChannelSettingsDialog } from '../guilds/dialogs/ChannelSettingsDialog';
import { CreateChannelDialog } from '../guilds/dialogs/CreateChannelDialog';
import { GuildSettingsDialog, type GuildSettingsTab } from '../guilds/dialogs/GuildSettingsDialog';
import { InviteDialog } from '../guilds/dialogs/InviteDialog';
import { groupChannels } from '../guilds/permissions';
import { SettingsPanel, type SettingsTab } from '../settings/SettingsPanel';
import { startVoiceSounds } from '../sounds/sound-player';
import { notifyMention } from '../unread/notify';
import { applyUnreadEvent, useUnreadTitle } from '../unread/unread-store';
import { useVoiceShortcuts } from '../voice/use-voice-shortcuts';
import { leaveVoice } from '../voice/voice-actions';
import { ChannelPanel } from './ChannelPanel';
import { MemberList } from './MemberList';
import { ServerRail } from './ServerRail';
import { SystemBar } from './SystemBar';
import { TextChannelView } from './TextChannelView';
import { UserPanel } from './UserPanel';
import { VoiceChannelView } from './VoiceChannelView';

type DialogState =
  | { kind: 'add-guild' }
  | { kind: 'invite' }
  | { kind: 'guild-settings'; tab?: GuildSettingsTab }
  | { kind: 'create-channel'; parentId: string | null }
  | { kind: 'channel-settings'; channelId: string }
  | { kind: 'settings'; tab?: SettingsTab }
  | null;

type Drawer = 'channels' | 'members' | null;

/**
 * The application shell, laid out like an IDE: server rail, channel panel, main area and
 * member list, separated by 1px rules. On small screens the side panels become drawers.
 */
export function AppPage() {
  const { guildId, channelId } = useParams();
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const status = useGatewayStore((state) => state.status);
  const guilds = useGatewayStore((state) => state.guilds);
  const order = useGatewayStore((state) => state.guildOrder);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [drawer, setDrawer] = useState<Drawer>(null);

  useVoiceShortcuts();
  useUnreadTitle();
  useEffect(() => startVoiceSounds(), []);

  // Event handlers registered once still need the current router.
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  });

  const queryClient = useQueryClient();
  useEffect(() => {
    // Chat history lives in the query cache; gateway events keep it current.
    const unsubscribe = gateway.subscribe((t, data) => {
      applyChatEvent(queryClient, t, data);
      const self = useAuthStore.getState().user;
      if (!self) return;
      const mention = applyUnreadEvent(t, data, self.id);
      if (mention) {
        notifyMention(mention, useGatewayStore.getState().guilds[mention.guildId], () =>
          navigateRef.current(`/app/${mention.guildId}/${mention.channelId}`),
        );
      }
    });
    const releaseAttachments = releaseAttachmentUrls(queryClient);
    gateway.start();
    return () => {
      unsubscribe();
      releaseAttachments();
      leaveVoice();
      gateway.stop();
    };
  }, [queryClient]);

  const guild = guildId ? guilds[guildId] : undefined;
  const groups = guild ? groupChannels(guild) : [];
  const numbered = groups.flatMap((group) => group.channels);
  // A thread is reached through its channel: it shows that channel's number.
  const current = numbered
    .flatMap((entry) => [
      { channel: entry.channel, number: entry.number, origin: null as string | null },
      ...entry.threads.map((thread) => ({
        channel: thread,
        number: entry.number,
        origin: entry.channel.name as string | null,
      })),
    ])
    .find((entry) => entry.channel.id === channelId);
  const hasLoaded = status === 'ready' || order.length > 0;

  // Keep the URL pointing at something that exists (guilds and channels come and go).
  useEffect(() => {
    if (!hasLoaded) return;
    if (!guild) {
      const first = order[0];
      if (guildId || first) navigate(first ? `/app/${first}` : '/app', { replace: true });
      return;
    }
    if (!current) {
      const fallback =
        numbered.find((entry) => entry.channel.type === 'text') ?? numbered[0] ?? null;
      const target = fallback ? `/app/${guild.id}/${fallback.channel.id}` : `/app/${guild.id}`;
      if (channelId || fallback) navigate(target, { replace: true });
    }
  }, [hasLoaded, guild, guildId, current, channelId, numbered, order, navigate]);

  if (!user) return null;

  const closeDialog = () => setDialog(null);
  const signOut = async () => {
    leaveVoice();
    gateway.stop();
    await logout();
  };
  const settingsChannel =
    dialog?.kind === 'channel-settings'
      ? guild?.channels.find((channel) => channel.id === dialog.channelId)
      : undefined;

  return (
    <div className="flex h-dvh flex-col bg-bg">
      <div className="relative flex min-h-0 flex-1">
        {drawer && (
          <button
            type="button"
            aria-label="Fechar painel"
            className="absolute inset-0 z-10 bg-black/60 lg:hidden"
            onClick={() => setDrawer(null)}
          />
        )}

        <aside
          className={cx(
            'absolute inset-y-0 left-0 z-20 flex w-[19rem] max-w-[90vw] bg-surface transition-transform md:static md:z-30 md:w-auto md:translate-x-0',
            drawer === 'channels' ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <ServerRail onAdd={() => setDialog({ kind: 'add-guild' })} />
          <div className="flex min-w-0 flex-1 flex-col border-r border-line md:w-60 md:flex-none">
            {guild ? (
              <ChannelPanel
                guild={guild}
                userId={user.id}
                onInvite={() => setDialog({ kind: 'invite' })}
                onCreateChannel={(parentId) => setDialog({ kind: 'create-channel', parentId })}
                onGuildSettings={() => setDialog({ kind: 'guild-settings' })}
                onChannelSettings={(channel) =>
                  setDialog({ kind: 'channel-settings', channelId: channel.id })
                }
                onNavigate={() => setDrawer(null)}
                onManageMembers={() => setDialog({ kind: 'guild-settings', tab: 'members' })}
              />
            ) : (
              <div className="flex-1" />
            )}
            <UserPanel user={user} onOpenSettings={(tab) => setDialog({ kind: 'settings', tab })} />
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
            <button
              type="button"
              className="label shrink-0 text-muted transition-colors hover:text-accent md:hidden"
              onClick={() => setDrawer('channels')}
            >
              [ CANAIS ]
            </button>
            {current ? (
              <h1 className="label-lg flex min-w-0 items-baseline gap-2">
                <span className="text-muted">{current.number}.</span>
                {current.origin && (
                  <span className="hidden truncate text-muted sm:inline">{current.origin} ›</span>
                )}
                <span className="truncate text-fg" data-testid="channel-title">
                  {current.channel.name}
                </span>
                {current.channel.topic && (
                  <span className="label hidden truncate text-muted normal-case sm:inline">
                    {current.channel.topic}
                  </span>
                )}
              </h1>
            ) : (
              <span className="label-lg text-muted">FREQUÊNCIA</span>
            )}
            {guild && (
              <button
                type="button"
                className="label ml-auto shrink-0 text-muted transition-colors hover:text-accent lg:hidden"
                onClick={() => setDrawer('members')}
              >
                [ MEMBROS ]
              </button>
            )}
          </header>

          <div className="min-h-0 flex-1">
            {!hasLoaded ? (
              <div className="grid-bg flex h-full items-center justify-center">
                <p className="label text-muted">CONECTANDO AO GATEWAY</p>
              </div>
            ) : !guild ? (
              <div className="grid-bg flex h-full items-center justify-center p-4">
                <section className="w-full max-w-sm border border-line bg-surface">
                  <header className="border-b border-line px-4 py-4">
                    <p className="label text-muted">00. INÍCIO</p>
                    <h2 className="display mt-1 text-xl text-fg">Nenhum servidor ainda</h2>
                  </header>
                  <div className="flex flex-col gap-3 p-4">
                    <p className="text-sm text-muted">
                      Crie um servidor para você e seus amigos, ou entre em um com um convite.
                    </p>
                    <Button variant="primary" onClick={() => setDialog({ kind: 'add-guild' })}>
                      CRIAR OU ENTRAR
                    </Button>
                  </div>
                </section>
              </div>
            ) : !current ? (
              <div className="grid-bg flex h-full items-center justify-center">
                <p className="label text-muted">NENHUM CANAL VISÍVEL</p>
              </div>
            ) : current.channel.type === 'voice' ? (
              <VoiceChannelView
                key={current.channel.id}
                guild={guild}
                channel={current.channel}
                userId={user.id}
                onManageMembers={() => setDialog({ kind: 'guild-settings', tab: 'members' })}
              />
            ) : (
              <TextChannelView
                key={current.channel.id}
                guild={guild}
                channel={current.channel}
                userId={user.id}
              />
            )}
          </div>
        </main>

        {guild && (
          <aside
            className={cx(
              'absolute inset-y-0 right-0 z-20 flex w-60 max-w-[80vw] flex-col border-l border-line bg-surface transition-transform lg:static lg:z-0 lg:translate-x-0',
              drawer === 'members' ? 'translate-x-0' : 'translate-x-full',
            )}
          >
            <MemberList
              guild={guild}
              userId={user.id}
              onManageMembers={() => setDialog({ kind: 'guild-settings', tab: 'members' })}
            />
          </aside>
        )}
      </div>

      <SystemBar />
      <ContextMenuHost />
      <ToastHost />

      {dialog?.kind === 'add-guild' && <AddGuildDialog onClose={closeDialog} />}
      {dialog?.kind === 'settings' && (
        <SettingsPanel
          user={user}
          guild={guild}
          initialTab={dialog.tab}
          onSignOut={() => void signOut()}
          onClose={closeDialog}
        />
      )}
      {guild && dialog?.kind === 'invite' && <InviteDialog guild={guild} onClose={closeDialog} />}
      {guild && dialog?.kind === 'guild-settings' && (
        <GuildSettingsDialog
          guild={guild}
          userId={user.id}
          initialTab={dialog.tab}
          onClose={closeDialog}
        />
      )}
      {guild && dialog?.kind === 'create-channel' && (
        <CreateChannelDialog guild={guild} parentId={dialog.parentId} onClose={closeDialog} />
      )}
      {guild && settingsChannel && (
        <ChannelSettingsDialog
          guild={guild}
          channel={settingsChannel}
          userId={user.id}
          onClose={closeDialog}
        />
      )}
    </div>
  );
}
