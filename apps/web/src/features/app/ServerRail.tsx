import { useQuery } from '@tanstack/react-query';
import { NavLink, useParams } from 'react-router-dom';
import { initials, pictureUrl } from '../../components/Avatar';
import { contextMenu } from '../../components/ContextMenu';
import { Icon } from '../../components/Icon';
import { cx } from '../../lib/cx';
import { HOME } from '../friends/dm';
import { FRIEND_REQUESTS_KEY, friendsApi } from '../friends/friends-api';
import { useGatewayStore } from '../gateway/gateway-store';
import { markGuildRead, sumUnread, useUnreadStore } from '../unread/unread-store';

/**
 * Leftmost rail: the home screen (friends and private conversations) on top, then one square
 * per server, plus the button to create or join one.
 */
export function ServerRail({ onAdd }: { onAdd: () => void }) {
  const guilds = useGatewayStore((state) => state.guilds);
  const order = useGatewayStore((state) => state.guildOrder);
  const unread = useUnreadStore((state) => state.channels);
  const { guildId } = useParams();
  const { data: requests = [] } = useQuery({
    queryKey: FRIEND_REQUESTS_KEY,
    queryFn: friendsApi.requests,
  });
  // What waits at home: messages of private conversations and requests to answer.
  const waiting =
    sumUnread(Object.values(unread).filter((entry) => guilds[entry.guildId]?.kind === 'dm')).count +
    requests.filter((request) => request.direction === 'incoming').length;
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
        className={cx(
          'relative flex h-10 w-10 shrink-0 items-center justify-center border transition-colors',
          atHome
            ? 'border-accent text-accent'
            : 'border-line-strong text-muted hover:border-accent hover:text-fg',
        )}
      >
        <Icon name="chat" size={18} />
        {waiting > 0 && (
          <span className="label absolute -right-1 -bottom-1 bg-fg px-1 text-bg">
            {waiting > 99 ? '99+' : waiting}
          </span>
        )}
      </NavLink>
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
                'display relative flex h-10 w-10 shrink-0 items-center justify-center border text-sm transition-colors',
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
              <span className="label absolute -right-1 -bottom-1 bg-fg px-1 text-bg">
                {pending.mentions > 99 ? '99+' : pending.mentions}
              </span>
            ) : (
              pending.count > 0 && (
                <span className="absolute -right-0.5 -bottom-0.5 h-2 w-2 bg-fg" />
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
        className="label-lg flex h-10 w-10 shrink-0 items-center justify-center border border-dashed border-line-strong text-muted transition-colors hover:border-accent hover:text-accent"
      >
        +
      </button>
    </nav>
  );
}
