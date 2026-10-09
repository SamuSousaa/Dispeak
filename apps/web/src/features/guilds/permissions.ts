import {
  computeBasePermissions,
  computeChannelPermissions,
  highestRolePosition,
  parsePermissions,
  type Channel,
  type Guild,
  type HierarchyActor,
  type Overwrite,
  type PermissionOverwrite,
} from '@frequencia/shared';

/**
 * Client-side permission math, using the same shared functions as the server. It only
 * decides what to show; the API enforces everything again.
 */

const toOverwrites = (overwrites: Overwrite[]): PermissionOverwrite[] =>
  overwrites.map((overwrite) => ({
    targetType: overwrite.targetType,
    targetId: overwrite.targetId,
    allow: parsePermissions(overwrite.allow),
    deny: parsePermissions(overwrite.deny),
  }));

export function actorIn(guild: Guild, userId: string): HierarchyActor {
  const member = guild.members.find((entry) => entry.user.id === userId);
  const roles = guild.roles.filter((role) => member?.roleIds.includes(role.id));
  const everyone = guild.roles.find((role) => role.id === guild.id);
  const isOwner = guild.ownerId === userId;
  return {
    isOwner,
    permissions: computeBasePermissions({
      isOwner,
      everyonePermissions: parsePermissions(everyone?.permissions ?? '0'),
      rolePermissions: roles.map((role) => parsePermissions(role.permissions)),
    }),
    highestRolePosition: highestRolePosition(roles),
  };
}

export function channelPermissions(guild: Guild, channel: Channel, userId: string): bigint {
  const member = guild.members.find((entry) => entry.user.id === userId);
  const parent = channel.parentId
    ? guild.channels.find((entry) => entry.id === channel.parentId)
    : undefined;
  return computeChannelPermissions({
    userId,
    everyoneRoleId: guild.id,
    roleIds: member?.roleIds ?? [],
    basePermissions: actorIn(guild, userId).permissions,
    channelType: channel.type,
    categoryOverwrites: parent ? toOverwrites(parent.overwrites) : undefined,
    channelOverwrites: toOverwrites(channel.overwrites),
  });
}

/** Name shown for a member: their server nickname, or their display name. */
export function memberName(guild: Guild, userId: string): string {
  const member = guild.members.find((entry) => entry.user.id === userId);
  return member?.nickname ?? member?.user.displayName ?? 'desconhecido';
}

export interface ChannelGroup {
  category: Channel | null;
  channels: Array<{ channel: Channel; number: string }>;
}

/**
 * Channels grouped under their categories in display order, each with its running number
 * (`01`, `02`, ...) used across the UI.
 */
export function groupChannels(guild: Guild): ChannelGroup[] {
  const byPosition = (a: Channel, b: Channel) => a.position - b.position;
  const categories = guild.channels
    .filter((channel) => channel.type === 'category')
    .sort(byPosition);
  const regular = guild.channels.filter((channel) => channel.type !== 'category');
  const known = new Set(categories.map((category) => category.id));

  let counter = 0;
  const numbered = (channels: Channel[]) =>
    channels.sort(byPosition).map((channel) => ({
      channel,
      number: String(++counter).padStart(2, '0'),
    }));

  const groups: ChannelGroup[] = [];
  const orphans = regular.filter((channel) => !channel.parentId || !known.has(channel.parentId));
  if (orphans.length > 0) groups.push({ category: null, channels: numbered(orphans) });
  for (const category of categories) {
    groups.push({
      category,
      channels: numbered(regular.filter((channel) => channel.parentId === category.id)),
    });
  }
  return groups;
}
