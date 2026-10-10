import { hasPermission, Permissions, type Channel, type Guild } from '@frequencia/shared';
import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Icon, type IconName } from '../../components/Icon';
import { cx } from '../../lib/cx';
import { actorIn, channelPermissions, groupChannels, memberName } from '../guilds/permissions';
import { useVoiceStore } from '../voice/voice-store';
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
        'inline-flex h-6 w-6 shrink-0 items-center justify-center text-muted transition-colors',
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
        {groupChannels(guild).map((group) => (
          <section key={group.category?.id ?? 'root'} className="mb-3">
            {group.category && (
              <div className="flex items-center justify-between gap-2 py-1 pr-1.5 pl-3">
                <h3 className="label truncate text-muted">{group.category.name}</h3>
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
              {group.channels.map(({ channel, number }) => {
                const voices = guild.voiceStates.filter((state) => state.channelId === channel.id);
                return (
                  <li key={channel.id}>
                    <div className="group flex items-center">
                      <NavLink
                        to={`/app/${guild.id}/${channel.id}`}
                        onClick={() => {
                          onNavigate();
                          // Like a phone call: picking a voice channel joins it right away.
                          if (
                            channel.type === 'voice' &&
                            connectedChannelId !== channel.id &&
                            hasPermission(
                              channelPermissions(guild, channel, userId),
                              Permissions.Connect,
                            )
                          ) {
                            connectToVoiceChannel(channel);
                          }
                        }}
                        className={({ isActive }) =>
                          cx(
                            'label-lg flex min-w-0 flex-1 items-center gap-2 border-l-2 py-1.5 pr-2 pl-[10px] transition-colors',
                            isActive
                              ? 'border-accent bg-surface-2 text-accent'
                              : 'border-transparent text-fg hover:bg-surface-2 hover:text-accent',
                          )
                        }
                      >
                        <span className="text-muted">{number}.</span>
                        <span className="truncate">{channel.name}</span>
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
                            className="label flex items-center gap-2 py-0.5 pr-3 pl-9"
                          >
                            <span
                              className={cx(
                                'truncate transition-colors',
                                speaking.has(voice.userId) ? 'text-accent' : 'text-muted',
                              )}
                            >
                              {memberName(guild, voice.userId)}
                            </span>
                            <span className="ml-auto flex shrink-0 gap-2">
                              {voice.streaming && <span className="text-accent">AO VIVO</span>}
                              {voice.deafened ? (
                                <span className="text-danger">SURDO</span>
                              ) : (
                                voice.muted && <span className="text-danger">MUDO</span>
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </nav>
    </div>
  );
}
