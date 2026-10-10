import {
  GUILD_SOUND_EVENTS,
  computeBasePermissions,
  computeChannelPermissions,
  hasPermission,
  highestRolePosition,
  Permissions,
  serializePermissions,
  type Channel,
  type Guild,
  type GuildSound,
  type GuildSoundEvent,
  type HierarchyActor,
  type Member,
  type PermissionOverwrite,
  type Role,
  type VoiceState,
} from '@frequencia/shared';
import { eq } from 'drizzle-orm';
import { schema, type Queryable } from '../../db/client';
import { forbidden, notFound } from '../../errors';

const {
  guilds,
  roles,
  channels,
  channelOverwrites,
  guildMembers,
  memberRoles,
  users,
  guildSounds,
} = schema;

export type RoleRow = typeof roles.$inferSelect;
export type ChannelRow = typeof channels.$inferSelect;

export interface MemberEntry {
  userId: string;
  username: string;
  displayName: string;
  avatarId: string | null;
  nickname: string | null;
  serverMuted: boolean;
  joinedAt: Date;
  /** Roles besides @everyone. */
  roleIds: string[];
}

/** Everything needed to answer permission questions about one guild, loaded in one go. */
export interface GuildSnapshot {
  guild: { id: string; name: string; ownerId: string; iconId: string | null };
  roles: Map<string, RoleRow>;
  channels: Map<string, ChannelRow>;
  overwrites: Map<string, PermissionOverwrite[]>;
  members: Map<string, MemberEntry>;
  /** Custom notification sounds, by event. */
  sounds: Map<string, GuildSound>;
}

export async function loadGuildSnapshot(
  db: Queryable,
  guildId: string,
): Promise<GuildSnapshot | null> {
  const [guild] = await db.select().from(guilds).where(eq(guilds.id, guildId));
  if (!guild) return null;

  const [roleRows, channelRows, overwriteRows, memberRows, memberRoleRows, soundRows] =
    await Promise.all([
      db.select().from(roles).where(eq(roles.guildId, guildId)),
      db.select().from(channels).where(eq(channels.guildId, guildId)),
      db
        .select({ overwrite: channelOverwrites })
        .from(channelOverwrites)
        .innerJoin(channels, eq(channels.id, channelOverwrites.channelId))
        .where(eq(channels.guildId, guildId)),
      db
        .select({ member: guildMembers, user: users })
        .from(guildMembers)
        .innerJoin(users, eq(users.id, guildMembers.userId))
        .where(eq(guildMembers.guildId, guildId)),
      db.select().from(memberRoles).where(eq(memberRoles.guildId, guildId)),
      db.select().from(guildSounds).where(eq(guildSounds.guildId, guildId)),
    ]);

  const overwrites = new Map<string, PermissionOverwrite[]>();
  for (const { overwrite } of overwriteRows) {
    const list = overwrites.get(overwrite.channelId) ?? [];
    list.push({
      targetType: overwrite.targetType,
      targetId: overwrite.targetId,
      allow: overwrite.allow,
      deny: overwrite.deny,
    });
    overwrites.set(overwrite.channelId, list);
  }

  const members = new Map<string, MemberEntry>();
  for (const { member, user } of memberRows) {
    members.set(user.id, {
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarId: user.avatarId,
      nickname: member.nickname,
      serverMuted: member.serverMuted,
      joinedAt: member.joinedAt,
      roleIds: [],
    });
  }
  for (const row of memberRoleRows) members.get(row.userId)?.roleIds.push(row.roleId);

  return {
    guild: { id: guild.id, name: guild.name, ownerId: guild.ownerId, iconId: guild.iconId },
    roles: new Map(roleRows.map((role) => [role.id, role])),
    channels: new Map(channelRows.map((channel) => [channel.id, channel])),
    overwrites,
    members,
    sounds: new Map(
      soundRows.map((row) => [row.event, { id: row.fileId, filename: row.filename }]),
    ),
  };
}

// --- permission questions -------------------------------------------------------------------

export interface Actor extends HierarchyActor {
  userId: string;
  member: MemberEntry;
}

/** The member acting on a guild, or `null` when the user does not belong to it. */
export function actorOf(snapshot: GuildSnapshot, userId: string): Actor | null {
  const member = snapshot.members.get(userId);
  if (!member) return null;
  const memberRoleRows = member.roleIds
    .map((roleId) => snapshot.roles.get(roleId))
    .filter((role): role is RoleRow => Boolean(role));
  const isOwner = snapshot.guild.ownerId === userId;
  return {
    userId,
    member,
    isOwner,
    permissions: computeBasePermissions({
      isOwner,
      everyonePermissions: snapshot.roles.get(snapshot.guild.id)?.permissions ?? 0n,
      rolePermissions: memberRoleRows.map((role) => role.permissions),
    }),
    highestRolePosition: highestRolePosition(memberRoleRows),
  };
}

/** Non-members get the same 404 as a guild that does not exist. */
export function requireActor(snapshot: GuildSnapshot | null, userId: string): Actor {
  const actor = snapshot ? actorOf(snapshot, userId) : null;
  if (!actor) throw notFound('guild');
  return actor;
}

export function requirePermission(actor: Actor, permission: bigint): void {
  if (!hasPermission(actor.permissions, permission)) throw forbidden();
}

/** Effective permissions of a member in a channel; `0n` for non-members. */
export function channelPermissionsOf(
  snapshot: GuildSnapshot,
  userId: string,
  channelId: string,
): bigint {
  const actor = actorOf(snapshot, userId);
  const channel = snapshot.channels.get(channelId);
  if (!actor || !channel) return 0n;
  if (channel.type === 'thread') {
    // A thread has no rules of its own: whoever can do something in the channel can do it here.
    const parent = channel.parentId ? snapshot.channels.get(channel.parentId) : undefined;
    return parent && parent.type !== 'thread'
      ? channelPermissionsOf(snapshot, userId, parent.id)
      : 0n;
  }
  return computeChannelPermissions({
    userId,
    everyoneRoleId: snapshot.guild.id,
    roleIds: actor.member.roleIds,
    basePermissions: actor.permissions,
    channelType: channel.type,
    categoryOverwrites: channel.parentId ? snapshot.overwrites.get(channel.parentId) : undefined,
    channelOverwrites: snapshot.overwrites.get(channel.id) ?? [],
  });
}

export function canViewChannel(
  snapshot: GuildSnapshot,
  userId: string,
  channelId: string,
): boolean {
  return hasPermission(channelPermissionsOf(snapshot, userId, channelId), Permissions.ViewChannel);
}

// --- serialization --------------------------------------------------------------------------

export function toRole(row: RoleRow): Role {
  return {
    id: row.id,
    guildId: row.guildId,
    name: row.name,
    permissions: serializePermissions(row.permissions),
    position: row.position,
    color: row.color,
  };
}

export function toChannel(snapshot: GuildSnapshot, row: ChannelRow): Channel {
  return {
    id: row.id,
    guildId: row.guildId,
    type: row.type,
    name: row.name,
    topic: row.topic,
    position: row.position,
    parentId: row.parentId,
    overwrites: (snapshot.overwrites.get(row.id) ?? []).map((overwrite) => ({
      targetType: overwrite.targetType,
      targetId: overwrite.targetId,
      allow: serializePermissions(overwrite.allow),
      deny: serializePermissions(overwrite.deny),
    })),
  };
}

export function toMember(entry: MemberEntry): Member {
  return {
    user: {
      id: entry.userId,
      username: entry.username,
      displayName: entry.displayName,
      avatar: entry.avatarId,
    },
    nickname: entry.nickname,
    roleIds: [...entry.roleIds],
    joinedAt: entry.joinedAt.toISOString(),
    serverMuted: entry.serverMuted,
  };
}

const byPosition = <T extends { position: number; id: string }>(a: T, b: T) =>
  a.position - b.position || a.id.localeCompare(b.id);

/** The guild as one member sees it: channels they cannot view are left out entirely. */
export function guildPayloadFor(
  snapshot: GuildSnapshot,
  userId: string,
  live: { onlineUserIds: string[]; voiceStates: VoiceState[] },
): Guild {
  const visible = [...snapshot.channels.values()]
    .filter((channel) => canViewChannel(snapshot, userId, channel.id))
    .sort(byPosition);
  const visibleIds = new Set(visible.map((channel) => channel.id));

  return {
    id: snapshot.guild.id,
    name: snapshot.guild.name,
    icon: snapshot.guild.iconId,
    ownerId: snapshot.guild.ownerId,
    channels: visible.map((channel) => toChannel(snapshot, channel)),
    roles: [...snapshot.roles.values()].sort((a, b) => b.position - a.position).map(toRole),
    members: [...snapshot.members.values()].map(toMember),
    onlineUserIds: live.onlineUserIds.filter((id) => snapshot.members.has(id)),
    voiceStates: live.voiceStates.filter((state) => visibleIds.has(state.channelId)),
    sounds: Object.fromEntries(
      GUILD_SOUND_EVENTS.map((event) => [event, snapshot.sounds.get(event) ?? null]),
    ) as Record<GuildSoundEvent, GuildSound | null>,
  };
}
