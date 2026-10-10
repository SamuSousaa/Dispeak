import { hasPermission, Permissions, type Guild, type Member } from '@frequencia/shared';
import { Avatar } from '../../components/Avatar';
import { contextMenu, openContextMenu, type MenuEntry } from '../../components/ContextMenu';
import { cx } from '../../lib/cx';
import { actorIn } from '../guilds/permissions';
import { volumeMenuEntries } from '../voice/components/VolumeControl';

interface RowProps {
  guild: Guild;
  member: Member;
  online: boolean;
  userId: string;
  onManageMembers: () => void;
}

function Row({ guild, member, online, userId, onManageMembers }: RowProps) {
  const roles = guild.roles
    .filter((role) => member.roleIds.includes(role.id))
    .sort((a, b) => b.position - a.position);
  const tag = guild.ownerId === member.user.id ? 'DONO' : (roles[0]?.name ?? null);
  const name = member.nickname ?? member.user.displayName;
  const actor = actorIn(guild, userId);
  const canManage =
    hasPermission(actor.permissions, Permissions.ManageRoles) ||
    hasPermission(actor.permissions, Permissions.KickMembers);

  const entries = (): Array<MenuEntry | false> => [
    ...(member.user.id === userId ? [] : volumeMenuEntries(member.user.id, name)),
    { type: 'separator' },
    {
      label: 'Copiar nome de usuário',
      hint: `@${member.user.username}`,
      onSelect: () => void navigator.clipboard?.writeText(member.user.username),
    },
    canManage && { label: 'Gerenciar membros', onSelect: onManageMembers },
  ];

  return (
    <li data-testid="member" data-online={online} {...contextMenu(name, entries)}>
      <button
        type="button"
        title={`${name} (@${member.user.username})`}
        className="flex w-full items-center justify-between gap-2 px-3 py-1 text-left transition-colors hover:bg-surface-2 focus-visible:-outline-offset-2"
        // A plain click opens the same menu, so it can be found without a right button.
        onClick={(event) =>
          openContextMenu({ x: event.clientX, y: event.clientY }, name, entries())
        }
      >
        <span className="flex min-w-0 items-center gap-2">
          <Avatar
            name={name}
            picture={member.user.avatar}
            size={24}
            className={cx(!online && 'opacity-50')}
          />
          <span className={cx('label-lg truncate', online ? 'text-fg' : 'text-muted')}>{name}</span>
        </span>
        {tag && <span className="label shrink-0 truncate text-muted">{tag}</span>}
      </button>
    </li>
  );
}

/** Right column: members split by presence. */
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
  const groups = [
    { label: 'ONLINE', members: guild.members.filter((m) => online.has(m.user.id)).sort(byName) },
    { label: 'OFFLINE', members: guild.members.filter((m) => !online.has(m.user.id)).sort(byName) },
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
              <section key={group.label} className="mb-3">
                <h3 className="label px-3 py-1 text-muted">
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
