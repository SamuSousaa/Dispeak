import type { Guild, Member } from '@frequencia/shared';
import { cx } from '../../lib/cx';

function Row({ guild, member, online }: { guild: Guild; member: Member; online: boolean }) {
  const roles = guild.roles
    .filter((role) => member.roleIds.includes(role.id))
    .sort((a, b) => b.position - a.position);
  const tag = guild.ownerId === member.user.id ? 'DONO' : (roles[0]?.name ?? null);
  return (
    <li
      data-testid="member"
      data-online={online}
      className="flex items-center justify-between gap-2 px-3 py-1"
    >
      <span className={cx('label-lg truncate', online ? 'text-fg' : 'text-muted')}>
        {member.nickname ?? member.user.displayName}
      </span>
      {tag && <span className="label shrink-0 truncate text-muted">{tag}</span>}
    </li>
  );
}

/** Right column: members split by presence. */
export function MemberList({ guild }: { guild: Guild }) {
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
