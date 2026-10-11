import { useQuery } from '@tanstack/react-query';
import { NavLink } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { cx } from '../../lib/cx';
import { StatusMark } from '../profile/ProfileCard';
import { sumUnread, useUnreadStore } from '../unread/unread-store';
import { HOME, useConversations } from './dm';
import { FRIEND_REQUESTS_KEY, friendsApi } from './friends-api';

const row =
  'flex items-center gap-2 px-3 py-1.5 transition-colors hover:bg-surface-2 focus-visible:-outline-offset-2 pointer-coarse:py-2.5';

/**
 * Channel column of the home screen: the way to the friends list and, below it, one line per
 * private conversation.
 */
export function DmPanel({ userId, onNavigate }: { userId: string; onNavigate: () => void }) {
  const conversations = useConversations(userId);
  const unread = useUnreadStore((state) => state.channels);
  const { data: requests = [] } = useQuery({
    queryKey: FRIEND_REQUESTS_KEY,
    queryFn: friendsApi.requests,
  });
  const incoming = requests.filter((request) => request.direction === 'incoming').length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center border-b border-line px-3">
        <h2 className="label-lg truncate text-fg">MENSAGENS DIRETAS</h2>
      </header>
      <nav aria-label="Conversas" className="min-h-0 flex-1 overflow-y-auto py-2">
        <NavLink
          to={`/app/${HOME}`}
          end
          onClick={onNavigate}
          className={({ isActive }) => cx(row, 'label-lg', isActive ? 'text-accent' : 'text-fg')}
        >
          <span className="text-muted">00.</span>
          <span className="flex-1">AMIGOS</span>
          {incoming > 0 && (
            <span className="label bg-fg px-1 text-bg" data-testid="friend-requests-badge">
              {incoming}
            </span>
          )}
        </NavLink>

        <h3 className="label mt-3 px-3 py-1 text-muted">CONVERSAS — {conversations.length}</h3>
        {conversations.length === 0 && (
          <p className="px-3 py-1 text-xs text-muted">
            Adicione um amigo para abrir a primeira conversa.
          </p>
        )}
        <ul>
          {conversations.map(({ guild, friend, online, inCall }) => {
            const pending = sumUnread(
              Object.values(unread).filter((entry) => entry.guildId === guild.id),
            );
            return (
              <li key={guild.id} data-testid="conversation">
                <NavLink
                  to={`/app/${guild.id}`}
                  onClick={onNavigate}
                  title={`${friend.user.displayName} (@${friend.user.username})`}
                  className={({ isActive }) => cx(row, isActive && 'bg-surface-2')}
                >
                  <span className="relative shrink-0">
                    <Avatar
                      name={friend.user.displayName}
                      picture={friend.user.avatar}
                      size={28}
                      className={cx(!online && 'opacity-50')}
                    />
                    <StatusMark
                      presence={online ? friend.user.status : 'offline'}
                      className="absolute -right-0.5 -bottom-0.5 h-2 w-2"
                    />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span
                      className={cx(
                        'label-lg truncate',
                        online || pending.count > 0 ? 'text-fg' : 'text-muted',
                      )}
                    >
                      {friend.user.displayName}
                    </span>
                    {inCall ? (
                      <span className="label text-accent">EM CHAMADA</span>
                    ) : (
                      online &&
                      friend.user.customStatus && (
                        <span className="truncate text-xs text-muted">
                          {friend.user.customStatus}
                        </span>
                      )
                    )}
                  </span>
                  {pending.count > 0 && (
                    <span className="label bg-fg px-1 text-bg" data-testid="conversation-unread">
                      {pending.count > 99 ? '99+' : pending.count}
                    </span>
                  )}
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
