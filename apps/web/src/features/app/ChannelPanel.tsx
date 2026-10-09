import { hasPermission, Permissions, type Channel, type Guild } from '@frequencia/shared';
import { NavLink } from 'react-router-dom';
import { cx } from '../../lib/cx';
import { actorIn, channelPermissions, groupChannels, memberName } from '../guilds/permissions';
import { useVoiceStore } from '../voice/voice-store';
import { useSpeakingUserIds } from './voice-channel';

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

const actionClass =
  'label shrink-0 text-muted transition-colors hover:text-accent focus-visible:text-accent';

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
  const connectedChannelId = useVoiceStore((state) => state.channelId);
  const speaking = useSpeakingUserIds(userId);

  const canConfigure = (channel: Channel) =>
    hasPermission(channelPermissions(guild, channel, userId), Permissions.ManageChannels) ||
    hasPermission(channelPermissions(guild, channel, userId), Permissions.ManageRoles);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
        <h2 className="display truncate text-sm text-fg" title={guild.name}>
          {guild.name}
        </h2>
        <button
          type="button"
          className={actionClass}
          onClick={onGuildSettings}
          aria-label="Configurações do servidor"
        >
          [ CFG ]
        </button>
      </header>

      <div className="flex shrink-0 items-center gap-3 border-b border-line px-3 py-2">
        {canInvite && (
          <button type="button" className={actionClass} onClick={onInvite}>
            [ CONVIDAR ]
          </button>
        )}
        {canManageChannels && (
          <button type="button" className={actionClass} onClick={() => onCreateChannel(null)}>
            [ + CANAL ]
          </button>
        )}
      </div>

      <nav aria-label="Canais" className="min-h-0 flex-1 overflow-y-auto py-2">
        {groupChannels(guild).map((group) => (
          <section key={group.category?.id ?? 'root'} className="mb-3">
            {group.category && (
              <div className="group flex items-center justify-between gap-2 px-3 py-1">
                <h3 className="label truncate text-muted">{group.category.name}</h3>
                <span className="flex gap-2 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                  {canManageChannels && (
                    <button
                      type="button"
                      className={actionClass}
                      aria-label={`Criar canal em ${group.category.name}`}
                      onClick={() => onCreateChannel(group.category?.id ?? null)}
                    >
                      +
                    </button>
                  )}
                  {canConfigure(group.category) && (
                    <button
                      type="button"
                      className={actionClass}
                      aria-label={`Configurar categoria ${group.category.name}`}
                      onClick={() => group.category && onChannelSettings(group.category)}
                    >
                      CFG
                    </button>
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
                        onClick={onNavigate}
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
                        <button
                          type="button"
                          className={cx(
                            actionClass,
                            'px-2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100',
                          )}
                          aria-label={`Configurar canal ${channel.name}`}
                          onClick={() => onChannelSettings(channel)}
                        >
                          CFG
                        </button>
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
