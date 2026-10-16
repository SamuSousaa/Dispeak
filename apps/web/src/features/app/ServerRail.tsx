import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { initials, pictureUrl } from '../../components/Avatar';
import { contextMenu } from '../../components/ContextMenu';
import { Icon } from '../../components/Icon';
import { toast } from '../../components/Toast';
import { cx } from '../../lib/cx';
import { describeError } from '../../lib/http';
import { HOME } from '../friends/dm';
import { FRIEND_REQUESTS_KEY, friendsApi } from '../friends/friends-api';
import { useGatewayStore } from '../gateway/gateway-store';
import { startMeeting } from '../meetings/meeting-store';
import { markGuildRead, sumUnread, useUnreadStore } from '../unread/unread-store';

/**
 * Leftmost rail: the home screen (friends and private conversations) on top, then one square
 * per server, plus the button to create or join one. Below home, the one that starts a meeting.
 */
export function ServerRail({ onAdd }: { onAdd: () => void }) {
  const guilds = useGatewayStore((state) => state.guilds);
  const order = useGatewayStore((state) => state.guildOrder);
  const unread = useUnreadStore((state) => state.channels);
  const { guildId } = useParams();
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);
  const newMeeting = async () => {
    setStarting(true);
    try {
      navigate(`/reuniao/${await startMeeting()}`);
    } catch (error) {
      toast(describeError(error, 'Não foi possível criar a reunião.'));
      setStarting(false);
    }
  };
  const { data: requests = [] } = useQuery({
    queryKey: FRIEND_REQUESTS_KEY,
    queryFn: friendsApi.requests,
  });
  // What waits at home: messages of private conversations and requests to answer. A message
  // request counts once, whatever it says, and a hidden one not at all.
  const listedDm = (id: string) => {
    const guild = guilds[id];
    return (
      guild?.kind === 'dm' && guild.dm?.request !== 'incoming' && guild.dm?.request !== 'hidden'
    );
  };
  const messageRequests = Object.values(guilds).filter(
    (guild) => guild.dm?.request === 'incoming',
  ).length;
  const waiting =
    sumUnread(Object.values(unread).filter((entry) => listedDm(entry.guildId))).count +
    requests.filter((request) => request.direction === 'incoming').length +
    messageRequests;
  const atHome = guildId === HOME || (guildId ? guilds[guildId]?.kind === 'dm' : false);

  return (
    <nav
      aria-label="Servidores"
      className="flex w-14 shrink-0 flex-col items-center gap-2 overflow-y-auto border-r border-line bg-bg py-2"
    >
      <NavLink
        to={`/app/${HOME}`}
        title="Amigos e mensagens diretas"
        aria-label={
          waiting > 0
            ? `Amigos e mensagens diretas, ${waiting} pendentes`
            : 'Amigos e mensagens diretas'
        }
        data-testid="home-link"
        data-unread={waiting > 0}
        data-current={atHome}
        className={cx(
          'rail-item relative flex h-10 w-10 shrink-0 items-center justify-center border',
          atHome
            ? 'border-accent text-accent'
            : 'border-line-strong text-muted hover:border-accent hover:text-fg',
        )}
      >
        <Icon name="chat" size={18} />
        {waiting > 0 && (
          <span className="label anim-badge absolute -right-1 -bottom-1 bg-fg px-1 text-bg">
            {waiting > 99 ? '99+' : waiting}
          </span>
        )}
      </NavLink>
      <button
        type="button"
        onClick={() => void newMeeting()}
        disabled={starting}
        title="Nova reunião: uma chamada por link, que some quando acaba"
        aria-label="Nova reunião"
        data-testid="new-meeting"
        className="rail-item relative flex h-10 w-10 shrink-0 items-center justify-center border border-line-strong text-muted hover:border-accent hover:text-accent disabled:opacity-40"
      >
        <Icon name="camera" size={18} />
      </button>
      <div aria-hidden="true" className="h-px w-8 shrink-0 bg-line" />
      {order.map((id) => {
        const guild = guilds[id];
        if (!guild || guild.kind !== 'server') return null;
        const pending = sumUnread(Object.values(unread).filter((entry) => entry.guildId === id));
        return (
          <NavLink
            key={id}
            to={`/app/${id}`}
            title={guild.name}
            aria-label={
              pending.mentions > 0
                ? `${guild.name}, ${pending.mentions} ${pending.mentions === 1 ? 'menção' : 'menções'}`
                : pending.count > 0
                  ? `${guild.name}, mensagens não lidas`
                  : guild.name
            }
            data-unread={pending.count > 0}
            {...contextMenu(guild.name, () => [
              pending.count > 0 && {
                label: 'Marcar tudo como lido',
                onSelect: () => markGuildRead(id),
              },
              {
                label: 'Copiar link do servidor',
                onSelect: () =>
                  void navigator.clipboard?.writeText(`${window.location.origin}/app/${id}`),
              },
            ])}
            className={({ isActive }) =>
              cx(
                'rail-item display relative flex h-10 w-10 shrink-0 items-center justify-center border text-sm',
                isActive
                  ? 'border-accent text-accent'
                  : 'border-line-strong text-muted hover:border-accent hover:text-fg',
              )
            }
          >
            {guild.icon ? (
              <img
                src={pictureUrl(guild.icon)}
                alt=""
                draggable={false}
                data-testid="guild-icon"
                className="h-full w-full object-cover"
              />
            ) : (
              initials(guild.name)
            )}
            {pending.mentions > 0 ? (
              <span className="label anim-badge absolute -right-1 -bottom-1 bg-fg px-1 text-bg">
                {pending.mentions > 99 ? '99+' : pending.mentions}
              </span>
            ) : (
              pending.count > 0 && (
                <span className="anim-badge absolute -right-0.5 -bottom-0.5 h-2 w-2 bg-fg" />
              )
            )}
          </NavLink>
        );
      })}
      <button
        type="button"
        onClick={onAdd}
        title="Criar ou entrar em um servidor"
        aria-label="Criar ou entrar em um servidor"
        className="rail-item label-lg relative flex h-10 w-10 shrink-0 items-center justify-center border border-dashed border-line-strong text-muted hover:border-accent hover:text-accent"
      >
        +
      </button>
    </nav>
  );
}
