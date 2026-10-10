import {
  hasPermission,
  parsePermissions,
  Permissions,
  type Channel,
  type Guild,
} from '@frequencia/shared';
import { guildApi } from './guild-api';
import { actorIn } from './permissions';

const SEE = Permissions.ViewChannel;

const bitsOf = (channel: Channel, targetId: string) => {
  const overwrite = channel.overwrites.find((entry) => entry.targetId === targetId);
  return {
    allow: parsePermissions(overwrite?.allow ?? '0'),
    deny: parsePermissions(overwrite?.deny ?? '0'),
  };
};

/** A private channel is one that @everyone is denied from seeing. */
export function isPrivate(guild: Guild, channel: Channel): boolean {
  return hasPermission(bitsOf(channel, guild.id).deny, SEE);
}

/** Whether a role or member was let into a private channel by name. */
export function isAllowedIn(channel: Channel, targetId: string): boolean {
  return hasPermission(bitsOf(channel, targetId).allow, SEE);
}

function write(
  channel: Channel,
  targetId: string,
  targetType: 'role' | 'member',
  allow: bigint,
  deny: bigint,
) {
  return allow === 0n && deny === 0n
    ? guildApi.deleteOverwrite(channel.id, targetId)
    : guildApi.putOverwrite(channel.id, targetId, {
        targetType,
        allow: allow.toString(),
        deny: deny.toString(),
      });
}

/**
 * Hides a channel from everyone, or shows it again. Whoever makes it private keeps their own
 * access, so nobody locks themselves out of a channel they were managing.
 */
export async function setPrivate(
  guild: Guild,
  channel: Channel,
  actorId: string,
  hidden: boolean,
): Promise<void> {
  const actor = actorIn(guild, actorId);
  const sovereign = actor.isOwner || hasPermission(actor.permissions, Permissions.Administrator);
  if (hidden && !sovereign) {
    const mine = bitsOf(channel, actorId);
    await write(channel, actorId, 'member', mine.allow | SEE, mine.deny & ~SEE);
  }
  const everyone = bitsOf(channel, guild.id);
  await write(
    channel,
    guild.id,
    'role',
    everyone.allow & ~SEE,
    hidden ? everyone.deny | SEE : everyone.deny & ~SEE,
  );
}

/** Lets a role or a member into a private channel, or takes that back. */
export function setAllowedIn(
  guild: Guild,
  channel: Channel,
  targetId: string,
  allowed: boolean,
): Promise<unknown> {
  const current = bitsOf(channel, targetId);
  const targetType = guild.roles.some((role) => role.id === targetId) ? 'role' : 'member';
  return write(
    channel,
    targetId,
    targetType,
    allowed ? current.allow | SEE : current.allow & ~SEE,
    current.deny & ~SEE,
  );
}
