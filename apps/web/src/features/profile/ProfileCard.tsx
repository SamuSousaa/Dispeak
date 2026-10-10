import type { User } from '@frequencia/shared';
import { Avatar, pictureUrl } from '../../components/Avatar';
import { cx } from '../../lib/cx';

export type Presence = User['status'] | 'offline';

export const PRESENCE_LABELS: Record<Presence, string> = {
  online: 'DISPONÍVEL',
  idle: 'AUSENTE',
  dnd: 'NÃO PERTURBE',
  offline: 'OFFLINE',
};

/**
 * How someone is around, told by shape as much as by colour: a filled square is available, a
 * hollow one is away, the danger colour asks not to be disturbed, a muted outline is offline.
 */
export function StatusMark({ presence, className }: { presence: Presence; className?: string }) {
  return (
    <span
      role="img"
      aria-label={PRESENCE_LABELS[presence].toLowerCase()}
      title={PRESENCE_LABELS[presence]}
      data-presence={presence}
      className={cx(
        'inline-block h-2.5 w-2.5 shrink-0 border',
        presence === 'online' && 'border-accent bg-accent',
        presence === 'idle' && 'border-accent bg-bg',
        presence === 'dnd' && 'border-danger bg-danger',
        presence === 'offline' && 'border-muted bg-bg',
        className,
      )}
    />
  );
}

export interface ProfileCardProps {
  user: User;
  /** Name shown: the nickname in the current server, or the display name. */
  name: string;
  presence: Presence;
  /** Colour of the highest role, for the name. */
  nameColor?: string;
  roles?: Array<{ id: string; name: string; color: string | null }>;
  /** ISO date the person joined the current server. */
  memberSince?: string;
  isOwner?: boolean;
}

const dateFormat = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

/**
 * What a person chose to show about themselves: banner, picture, the line about what they are
 * up to and the "about me", plus what the server knows (roles, since when they are a member).
 */
export function ProfileCard({
  user,
  name,
  presence,
  nameColor,
  roles = [],
  memberSince,
  isOwner = false,
}: ProfileCardProps) {
  return (
    <div data-testid="profile-card" className="flex flex-col">
      <div
        className="h-20 w-full bg-surface"
        style={{
          backgroundColor: user.accentColor ?? undefined,
          backgroundImage: user.banner ? `url(${pictureUrl(user.banner)})` : undefined,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }}
      />
      <div className="flex flex-col gap-2 px-3 pb-3">
        <div className="-mt-8 flex items-end justify-between gap-2">
          <span className="relative">
            <Avatar
              name={name}
              picture={user.avatar}
              size={64}
              className="border-2 border-surface-2"
            />
            <StatusMark
              presence={presence}
              className="absolute -right-0.5 -bottom-0.5 h-3.5 w-3.5"
            />
          </span>
          <span className="label mb-1 text-muted">{PRESENCE_LABELS[presence]}</span>
        </div>
        <div className="min-w-0">
          <p
            className="label-lg truncate text-fg"
            style={nameColor ? { color: nameColor } : undefined}
          >
            {name}
            {isOwner && <span className="label text-muted"> · DONO</span>}
          </p>
          <p className="label truncate text-muted normal-case">@{user.username}</p>
        </div>
        {user.customStatus && (
          <p className="text-sm break-words text-fg" data-testid="profile-status">
            {user.customStatus}
          </p>
        )}
        {user.bio && (
          <div>
            <p className="label text-muted">SOBRE MIM</p>
            <p
              className="text-sm break-words whitespace-pre-wrap text-fg"
              data-testid="profile-bio"
            >
              {user.bio}
            </p>
          </div>
        )}
        {roles.length > 0 && (
          <div>
            <p className="label text-muted">CARGOS</p>
            <ul className="mt-1 flex flex-wrap gap-1">
              {roles.map((role) => (
                <li
                  key={role.id}
                  className="label border border-line-strong px-1.5 py-0.5 text-fg"
                  style={role.color ? { color: role.color, borderColor: role.color } : undefined}
                >
                  {role.name}
                </li>
              ))}
            </ul>
          </div>
        )}
        {memberSince && (
          <p className="label text-muted">
            NO SERVIDOR DESDE{' '}
            {dateFormat.format(new Date(memberSince)).replace('.', '').toUpperCase()}
          </p>
        )}
      </div>
    </div>
  );
}
