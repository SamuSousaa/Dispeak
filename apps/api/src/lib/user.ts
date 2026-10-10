import type { PresenceMode, Self, User } from '@frequencia/shared';
import { schema } from '../db/client';

const { users } = schema;

/** The columns of a user that other people get to see. */
export const publicUserColumns = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  avatarId: users.avatarId,
  bannerId: users.bannerId,
  bio: users.bio,
  customStatus: users.customStatus,
  accentColor: users.accentColor,
  presenceMode: users.presenceMode,
};

export type PublicUserRow = Pick<typeof users.$inferSelect, keyof typeof publicUserColumns>;

/**
 * A user as everyone else sees them. Someone who chose to be invisible is reported like anyone
 * who is simply available: what hides them is being left out of the list of who is online.
 */
export function toPublicUser(row: PublicUserRow): User {
  const mode = row.presenceMode as PresenceMode;
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatar: row.avatarId,
    banner: row.bannerId,
    bio: row.bio,
    customStatus: row.customStatus,
    accentColor: row.accentColor,
    status: mode === 'invisible' ? 'online' : mode,
  };
}

/** The user as they see themselves, with the choices nobody else is told about. */
export function toSelf(row: PublicUserRow): Self {
  return { ...toPublicUser(row), presence: row.presenceMode as PresenceMode };
}
