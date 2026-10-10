import { hasPermission, Permissions, type Channel, type Guild } from '@frequencia/shared';
import { useEffect, useRef, useState } from 'react';
import { NavLink, useParams } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { contextMenu } from '../../components/ContextMenu';
import { attempt } from '../../components/Toast';
import { Icon, type IconName } from '../../components/Icon';
import { cx } from '../../lib/cx';
import { isPrivate, setPrivate } from '../guilds/channel-privacy';
import { actorIn, channelPermissions, groupChannels, memberName } from '../guilds/permissions';
import { userMenu } from '../guilds/user-menu';
import { markRead, useUnreadStore } from '../unread/unread-store';
import { useVoiceStore } from '../voice/voice-store';
import { toggleCollapsed, useUiStore } from './ui-store';
import { connectToVoiceChannel, useSpeakingUserIds } from './voice-channel';

interface ChannelPanelProps {
  guild: Guild;
  userId: string;
  onInvite: () => void;
  onCreateChannel: (parentId: string | null) => void;
  onGuildSettings: () => void;
  onChannelSettings: (channel: Channel) => void;
  /** Called after navigating, so a mobile drawer can close. */
  onNavigate: () => void;
  onManageMembers: () => void;
}

/** Small icon action inside a channel or category row. */
function RowAction({
  icon,
  label,
  onClick,
  className,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex h-6 w-6 shrink-0 items-center justify-center text-muted transition-colors pointer-coarse:h-10 pointer-coarse:w-9',
        'hover:bg-surface-2 hover:text-accent focus-visible:text-accent',
        className,
      )}
      onClick={onClick}
    >
      <Icon name={icon} size={14} />
    </button>
  );
}

interface ServerAction {
  label: string;
  hint: string;
  run: () => void;
}

/** The server name opens the list of things that can be done with the server. */
function ServerHeader({
  guild,
  actions,
  onInvite,
}: {
  guild: Guild;
  actions: ServerAction[];
  /** Shortcut next to the name, present when the user may invite. */
  onInvite?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <header ref={ref} className="relative flex h-12 shrink-0 border-b border-line">
      <h2 className="min-w-0 flex-1">
        <button
          type="button"
          data-testid="server-menu"
          aria-haspopup="menu"
          aria-expanded={open}
          title={guild.name}
          className={cx(
            'flex h-full w-full items-center justify-between gap-2 px-3 text-left transition-colors',
            'hover:bg-surface-2 hover:text-accent focus-visible:-outline-offset-2',
            open ? 'bg-surface-2 text-accent' : 'text-fg',
          )}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="display truncate text-sm">{guild.name}</span>
          <Icon name="chevron-down" size={14} />
        </button>
      </h2>
      {onInvite && (
        <button
          type="button"
          aria-label="Convidar pessoas"
          title="Convidar pessoas"
          className="inline-flex w-11 shrink-0 items-center justify-center border-l border-line text-muted transition-colors hover:bg-surface-2 hover:text-accent focus-visible:-outline-offset-2"
          onClick={onInvite}
        >
          <Icon name="invite" />
        </button>
      )}
      {open && (
        <ul
          role="menu"
          aria-label={`Ações de ${guild.name}`}
          className="anim-drop absolute top-full right-0 left-0 z-10 border-b border-line-strong bg-surface-2"
        >
          {actions.map((action) => (
            <li key={action.label} role="none" className="border-b border-line last:border-b-0">
              <button
                type="button"
                role="menuitem"
                className="group flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors hover:bg-surface focus-visible:-outline-offset-2"
                onClick={() => {
                  setOpen(false);
                  action.run();
                }}
              >
                <span className="label text-fg transition-colors group-hover:text-accent">
                  {action.label}
                </span>
                <span className="text-xs text-muted">{action.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </header>
  );
}

/** Second column: the server header and its channels, grouped by category and numbered. */
export function ChannelPanel({
  guild,
  userId,
  onInvite,
  onCreateChannel,
  onGuildSettings,
  onChannelSettings,
  onNavigate,
  onManageMembers,
}: ChannelPanelProps) {
  const actor = actorIn(guild, userId);
  const canManageChannels = hasPermission(actor.permissions, Permissions.ManageChannels);
  const canInvite = hasPermission(actor.permissions, Permissions.CreateInvite);
  const canManageServer = [
    Permissions.ManageGuild,
    Permissions.ManageRoles,
    Permissions.KickMembers,
  ].some((permission) => hasPermission(actor.permissions, permission));
  const connectedChannelId = useVoiceStore((state) => state.channelId);
  const speaking = useSpeakingUserIds(userId);
  const unread = useUnreadStore((state) => state.channels);
  const collapsed = useUiStore((state) => state.collapsed);
  const { channelId: openChannelId } = useParams();

  const canConfigureAccess = (channel: Channel) =>
    hasPermission(channelPermissions(guild, channel, userId), Permissions.ManageRoles);
  const canConnectTo = (channel: Channel) =>
    hasPermission(channelPermissions(guild, channel, userId), Permissions.Connect);
  const copyLink = (channel: Channel) =>
    void navigator.clipboard?.writeText(`${window.location.origin}/app/${guild.id}/${channel.id}`);

  const canConfigure = (channel: Channel) =>
    hasPermission(channelPermissions(guild, channel, userId), Permissions.ManageChannels) ||
    hasPermission(channelPermissions(guild, channel, userId), Permissions.ManageRoles);

  const serverActions: ServerAction[] = [
    ...(canInvite
      ? [{ label: 'CONVIDAR PESSOAS', hint: 'Gerar um link de convite', run: onInvite }]
      : []),
    ...(canManageChannels
      ? [
          {
            label: 'CRIAR CANAL',
            hint: 'Texto, voz ou categoria',
            run: () => onCreateChannel(null),
          },
        ]
      : []),
    // Members who manage nothing only find the member list and the way out in there.
    canManageServer
      ? {
          label: 'CONFIGURAÇÕES DO SERVIDOR',
          hint: 'Nome, cargos, membros e convites',
          run: onGuildSettings,
        }
      : {
          label: 'OPÇÕES DO SERVIDOR',
          hint: 'Ver membros ou sair do servidor',
          run: onGuildSettings,
        },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ServerHeader
        guild={guild}
        actions={serverActions}
        onInvite={canInvite ? onInvite : undefined}
      />

      <nav aria-label="Canais" className="min-h-0 flex-1 overflow-y-auto py-2">
        {groupChannels(guild).map((group) => {
          const folded = Boolean(group.category && collapsed[group.category.id]);
          // A folded category still shows where the user is and what is waiting for them.
          const shown = folded
            ? group.channels.filter(
                ({ channel, threads }) =>
                  threads.some(
                    (thread) => thread.id === openChannelId || Boolean(unread[thread.id]),
                  ) ||
                  channel.id === openChannelId ||
                  channel.id === connectedChannelId ||
                  Boolean(unread[channel.id]),
              )
            : group.channels;
          return (
            <section key={group.category?.id ?? 'root'} className="mb-3">
              {group.category && (
                <div
                  className="flex items-center justify-between gap-2 py-1 pr-1.5 pl-3"
                  {...contextMenu(group.category.name, () => [
                    canManageChannels && {
                      label: 'Criar canal aqui',
                      onSelect: () => onCreateChannel(group.category?.id ?? null),
                    },
                    group.category &&
                      canConfigure(group.category) && {
                        label: 'Configurar categoria',
                        onSelect: () => group.category && onChannelSettings(group.category),
                      },
                  ])}
                >
                  <h3 className="min-w-0 flex-1">
                    <button
                      type="button"
                      aria-expanded={!folded}
                      title={folded ? 'Mostrar canais' : 'Recolher canais'}
                      data-testid="category-toggle"
                      className="label flex w-full items-center gap-1 truncate text-left text-muted transition-colors hover:text-fg"
                      onClick={() => group.category && toggleCollapsed(group.category.id)}
                    >
                      <span className={cx('shrink-0 transition-transform', folded && '-rotate-90')}>
                        <Icon name="chevron-down" size={12} />
                      </span>
                      <span className="truncate">{group.category.name}</span>
                    </button>
                  </h3>
                  <span className="flex shrink-0">
                    {canManageChannels && (
                      <RowAction
                        icon="plus"
                        label={`Criar canal em ${group.category.name}`}
                        onClick={() => onCreateChannel(group.category?.id ?? null)}
                      />
                    )}
                    {canConfigure(group.category) && (
                      <RowAction
                        icon="settings"
                        label={`Configurar categoria ${group.category.name}`}
                        onClick={() => group.category && onChannelSettings(group.category)}
                      />
                    )}
                  </span>
                </div>
              )}
              <ul>
                {shown.map(({ channel, number, threads }) => {
                  const voices = guild.voiceStates.filter(
                    (state) => state.channelId === channel.id,
                  );
                  const pending = unread[channel.id];
                  const joinable =
                    channel.type === 'voice' &&
                    connectedChannelId !== channel.id &&
                    canConnectTo(channel);
                  return (
                    <li key={channel.id}>
                      <div
                        className="group flex items-center"
                        data-testid="channel-row"
                        data-unread={Boolean(pending)}
                        {...contextMenu(channel.name, () => [
                          pending && {
                            label: 'Marcar como lido',
                            onSelect: () => markRead(channel.id),
                          },
                          joinable && {
                            label: 'Entrar no canal',
                            onSelect: () => connectToVoiceChannel(channel),
                          },
                          { label: 'Copiar link do canal', onSelect: () => copyLink(channel) },
                          { type: 'separator' },
                          canConfigureAccess(channel) && {
                            label: isPrivate(guild, channel) ? 'Tornar público' : 'Tornar privado',
                            onSelect: () =>
                              attempt(() =>
                                setPrivate(guild, channel, userId, !isPrivate(guild, channel)),
                              ),
                          },
                          canInvite && { label: 'Convidar pessoas', onSelect: onInvite },
                          canConfigure(channel) && {
                            label: 'Configurar canal',
                            onSelect: () => onChannelSettings(channel),
                          },
                          canManageChannels && {
                            label: 'Criar canal',
                            onSelect: () => onCreateChannel(channel.parentId),
                          },
                        ])}
                      >
                        <NavLink
                          to={`/app/${guild.id}/${channel.id}`}
                          onClick={() => {
                            onNavigate();
                            // Like a phone call: picking a voice channel joins it right away.
                            if (joinable) connectToVoiceChannel(channel);
                          }}
                          className={({ isActive }) =>
                            cx(
                              'label-lg flex min-w-0 flex-1 items-center gap-2 border-l-2 py-1.5 pr-2 pl-[10px] transition-colors pointer-coarse:py-3',
                              isActive
                                ? 'border-accent bg-surface-2 text-accent'
                                : 'border-transparent text-fg hover:bg-surface-2 hover:text-accent',
                            )
                          }
                        >
                          <span className="text-muted">{number}.</span>
                          <span className={cx('truncate', pending && 'font-semibold')}>
                            {channel.name}
                          </span>
                          {isPrivate(guild, channel) && (
                            <span className="shrink-0 text-muted" title="Canal privado">
                              <Icon name="lock" size={12} />
                              <span className="sr-only">privado</span>
                            </span>
                          )}
                          {pending &&
                            (pending.mentions > 0 ? (
                              <span
                                className="label ml-auto shrink-0 bg-fg px-1 text-bg"
                                data-testid="mention-badge"
                                aria-label={`${pending.mentions} ${pending.mentions === 1 ? 'menção' : 'menções'}`}
                              >
                                {pending.mentions > 99 ? '99+' : pending.mentions}
                              </span>
                            ) : (
                              <span
                                className="ml-auto h-1.5 w-1.5 shrink-0 bg-fg"
                                data-testid="unread-dot"
                                role="img"
                                aria-label="Mensagens não lidas"
                              />
                            ))}
                          {channel.type === 'voice' && (
                            <span
                              className={cx(
                                'label ml-auto shrink-0',
                                connectedChannelId === channel.id ? 'text-accent' : 'text-muted',
                              )}
                            >
                              VOZ{voices.length > 0 ? ` · ${voices.length}` : ''}
                            </span>
                          )}
                        </NavLink>
                        {canConfigure(channel) && (
                          <RowAction
                            icon="settings"
                            label={`Configurar canal ${channel.name}`}
                            onClick={() => onChannelSettings(channel)}
                            // Always there on touch screens; on desktop it shows with the row.
                            className="mx-1 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
                          />
                        )}
                      </div>
                      {voices.length > 0 && (
                        <ul className="pb-1" aria-label={`Conectados em ${channel.name}`}>
                          {voices.map((voice) => (
                            <li
                              key={voice.userId}
                              data-testid="voice-member"
                              className="label flex cursor-pointer items-center gap-2 py-0.5 pr-3 pl-8 transition-colors hover:bg-surface-2 pointer-coarse:py-2"
                              {...userMenu({
                                guild,
                                targetId: voice.userId,
                                selfId: userId,
                                onManageMembers,
                              })}
                            >
                              <Avatar
                                name={memberName(guild, voice.userId)}
                                picture={
                                  guild.members.find((entry) => entry.user.id === voice.userId)
                                    ?.user.avatar
                                }
                                size={18}
                              />
                              <span
                                className={cx(
                                  'truncate transition-colors',
                                  speaking.has(voice.userId) ? 'text-accent' : 'text-muted',
                                )}
                              >
                                {memberName(guild, voice.userId)}
                              </span>
                              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                                {voice.streaming && <span className="text-accent">AO VIVO</span>}
                                {guild.members.find((entry) => entry.user.id === voice.userId)
                                  ?.serverMuted && (
                                  <span className="text-danger" title="Mutado no servidor">
                                    [M]<span className="sr-only"> mutado no servidor</span>
                                  </span>
                                )}
                                {(voice.muted || voice.deafened) && (
                                  <span
                                    className="text-danger"
                                    title={voice.deafened ? 'Ensurdecido' : 'Microfone mutado'}
                                  >
                                    <Icon name="mic-off" size={12} />
                                    <span className="sr-only">MUDO</span>
                                  </span>
                                )}
                                {voice.deafened && (
                                  <span className="text-danger" title="Ensurdecido">
                                    <Icon name="headphones-off" size={12} />
                                    <span className="sr-only">SURDO</span>
                                  </span>
                                )}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {threads.length > 0 && (
                        <ul className="pb-1" aria-label={`Tópicos de ${channel.name}`}>
                          {threads.map((thread) => {
                            const waiting = unread[thread.id];
                            return (
                              <li
                                key={thread.id}
                                data-testid="thread-row"
                                data-unread={Boolean(waiting)}
                                {...contextMenu(thread.name, () => [
                                  waiting && {
                                    label: 'Marcar como lido',
                                    onSelect: () => markRead(thread.id),
                                  },
                                  {
                                    label: 'Copiar link do tópico',
                                    onSelect: () => copyLink(thread),
                                  },
                                  canConfigure(thread) && {
                                    label: 'Renomear ou excluir tópico',
                                    onSelect: () => onChannelSettings(thread),
                                  },
                                ])}
                              >
                                <NavLink
                                  to={`/app/${guild.id}/${thread.id}`}
                                  onClick={onNavigate}
                                  className={({ isActive }) =>
                                    cx(
                                      'label flex items-center gap-1.5 border-l-2 py-1 pr-3 pl-8 transition-colors pointer-coarse:py-2.5',
                                      isActive
                                        ? 'border-accent bg-surface-2 text-accent'
                                        : 'border-transparent text-muted hover:bg-surface-2 hover:text-accent',
                                    )
                                  }
                                >
                                  <span aria-hidden="true">↳</span>
                                  <span
                                    className={cx('truncate', waiting && 'font-semibold text-fg')}
                                  >
                                    {thread.name}
                                  </span>
                                  {waiting &&
                                    (waiting.mentions > 0 ? (
                                      <span className="label ml-auto shrink-0 bg-fg px-1 text-bg">
                                        {waiting.mentions > 99 ? '99+' : waiting.mentions}
                                      </span>
                                    ) : (
                                      <span
                                        className="ml-auto h-1.5 w-1.5 shrink-0 bg-fg"
                                        role="img"
                                        aria-label="Mensagens não lidas"
                                      />
                                    ))}
                                </NavLink>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </nav>
    </div>
  );
}
