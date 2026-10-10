import type { Guild, Member } from '@frequencia/shared';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { cx } from '../../lib/cx';
import { highestRole, memberColor } from '../guilds/permissions';
import { userMenu } from '../guilds/user-menu';
import { StatusMark } from '../profile/ProfileCard';

interface RowProps {
  guild: Guild;
  member: Member;
  online: boolean;
  userId: string;
  onManageMembers: () => void;
}

function Row({ guild, member, online, userId, onManageMembers }: RowProps) {
  const name = member.nickname ?? member.user.displayName;
  const isOwner = guild.ownerId === member.user.id;
  const color = online ? memberColor(guild, member.user.id) : undefined;

  return (
    <li data-testid="member" data-online={online}>
      <button
        type="button"
        title={`${name} (@${member.user.username})`}
        className="flex w-full items-center justify-between gap-2 px-3 py-1 text-left transition-colors hover:bg-surface-2 focus-visible:-outline-offset-2 pointer-coarse:py-2"
        {...userMenu({ guild, targetId: member.user.id, selfId: userId, onManageMembers })}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="relative shrink-0">
            <Avatar
              name={name}
              picture={member.user.avatar}
              size={28}
              className={cx(!online && 'opacity-50')}
            />
            <StatusMark
              presence={online ? member.user.status : 'offline'}
              className="absolute -right-0.5 -bottom-0.5 h-2 w-2"
            />
          </span>
          <span className="flex min-w-0 flex-col">
            <span
              className={cx('label-lg truncate', online ? 'text-fg' : 'text-muted')}
              style={color ? { color } : undefined}
            >
              {name}
            </span>
            {online && member.user.customStatus && (
              <span className="truncate text-xs text-muted" data-testid="member-status">
                {member.user.customStatus}
              </span>
            )}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-muted">
          {member.serverMuted && (
            <span className="text-danger" title="Mutado no servidor">
              <Icon name="mic-off" size={12} />
            </span>
          )}
          {isOwner && <span className="label">DONO</span>}
        </span>
      </button>
    </li>
  );
}

/**
 * Right column. People who are online come first, under the highest role they hold (in the
 * order of the hierarchy), then those online without a role, then everyone who is offline.
 */
export function MemberList({
  guild,
  userId,
  onManageMembers,
}: {
  guild: Guild;
  userId: string;
  /** Opens the server settings on the member list. */
  onManageMembers: () => void;
}) {
  const online = new Set(guild.onlineUserIds);
  const byName = (a: Member, b: Member) =>
    (a.nickname ?? a.user.displayName).localeCompare(b.nickname ?? b.user.displayName, 'pt-BR');
  const here = guild.members.filter((member) => online.has(member.user.id)).sort(byName);
  const away = guild.members.filter((member) => !online.has(member.user.id)).sort(byName);

  const ranked = guild.roles
    .filter((role) => role.id !== guild.id)
    .sort((a, b) => b.position - a.position);
  const groups = [
    ...ranked.map((role) => ({
      key: role.id,
      label: role.name,
      color: role.color,
      members: here.filter((member) => highestRole(guild, member)?.id === role.id),
    })),
    {
      key: 'online',
      label: 'ONLINE',
      color: null,
      members: here.filter((member) => !highestRole(guild, member)),
    },
    { key: 'offline', label: 'OFFLINE', color: null, members: away },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center border-b border-line px-3">
        <h2 className="label text-muted">MEMBROS — {guild.members.length}</h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {groups.map(
          (group) =>
            group.members.length > 0 && (
              <section key={group.key} className="mb-3" data-testid="member-group">
                <h3
                  className="label truncate px-3 py-1 text-muted"
                  style={group.color ? { color: group.color } : undefined}
                >
                  {group.label} — {group.members.length}
                </h3>
                <ul>
                  {group.members.map((member) => (
                    <Row
                      key={member.user.id}
                      guild={guild}
                      member={member}
                      online={online.has(member.user.id)}
                      userId={userId}
                      onManageMembers={onManageMembers}
                    />
                  ))}
                </ul>
              </section>
            ),
        )}
      </div>
    </div>
  );
}
