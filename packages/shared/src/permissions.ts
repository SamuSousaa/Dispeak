import { z } from 'zod';

/**
 * Permission bitflags, combined with bitwise OR. They travel over JSON as decimal strings
 * because bigint is not serializable.
 */
export const Permissions = {
  /** See the channel and read its history. */
  ViewChannel: 1n << 0n,
  SendMessages: 1n << 1n,
  /** Delete other members' messages. */
  ManageMessages: 1n << 2n,
  MentionEveryone: 1n << 3n,
  /** Join a voice channel. */
  Connect: 1n << 4n,
  /** Publish microphone audio. */
  Speak: 1n << 5n,
  /** Publish video: a screen share or the camera. */
  Stream: 1n << 6n,
  CreateInvite: 1n << 7n,
  KickMembers: 1n << 8n,
  /** Create, edit, reorder and delete channels. */
  ManageChannels: 1n << 9n,
  /** Create, edit and assign roles below one's own, and edit channel overwrites. */
  ManageRoles: 1n << 10n,
  /** Rename the server and manage its invites. */
  ManageGuild: 1n << 11n,
  /** Every permission, and immunity to channel overwrites. */
  Administrator: 1n << 12n,
  /** Send images along with messages. */
  AttachFiles: 1n << 13n,
  AddReactions: 1n << 14n,
  /** Silence other members' microphones in voice channels. */
  MuteMembers: 1n << 15n,
  /** Take other members out of a voice channel. */
  DisconnectMembers: 1n << 16n,
  BanMembers: 1n << 17n,
} as const;

export type PermissionName = keyof typeof Permissions;

export const PERMISSION_NAMES = Object.keys(Permissions) as PermissionName[];

export const ALL_PERMISSIONS = Object.values(Permissions).reduce((all, bit) => all | bit, 0n);

/** What the @everyone role grants in a freshly created server. */
export const DEFAULT_EVERYONE_PERMISSIONS =
  Permissions.ViewChannel |
  Permissions.SendMessages |
  Permissions.Connect |
  Permissions.Speak |
  Permissions.Stream |
  Permissions.CreateInvite |
  Permissions.AttachFiles |
  Permissions.AddReactions;

/** Permissions that only make sense inside a voice channel. */
const VOICE_ONLY = Permissions.Speak | Permissions.Stream;

export function hasPermission(permissions: bigint, required: bigint): boolean {
  return (permissions & required) === required;
}

export function serializePermissions(permissions: bigint): string {
  return permissions.toString();
}

const BITS_PATTERN = /^\d{1,20}$/;

/** Decimal string holding only known permission bits. */
export const permissionBitsSchema = z
  .string()
  .regex(BITS_PATTERN)
  .refine(
    // Malformed input is already reported by the pattern check above.
    (value) => !BITS_PATTERN.test(value) || (BigInt(value) & ~ALL_PERMISSIONS) === 0n,
    'unknown permission bits',
  );

export function parsePermissions(value: string): bigint {
  return BigInt(value) & ALL_PERMISSIONS;
}

// --- computation ----------------------------------------------------------------------------

export type OverwriteTarget = 'role' | 'member';

export interface PermissionOverwrite {
  targetType: OverwriteTarget;
  /** Role id or user id. */
  targetId: string;
  allow: bigint;
  deny: bigint;
}

export interface BasePermissionInput {
  isOwner: boolean;
  /** Permissions of the @everyone role. */
  everyonePermissions: bigint;
  /** Permissions of every additional role the member has. */
  rolePermissions: bigint[];
}

/** Server-wide permissions of a member: @everyone plus all of their roles. */
export function computeBasePermissions(input: BasePermissionInput): bigint {
  if (input.isOwner) return ALL_PERMISSIONS;
  const permissions = input.rolePermissions.reduce(
    (all, bits) => all | bits,
    input.everyonePermissions,
  );
  return hasPermission(permissions, Permissions.Administrator) ? ALL_PERMISSIONS : permissions;
}

export interface OverwriteContext {
  userId: string;
  /** Id of the @everyone role (equal to the server id). */
  everyoneRoleId: string;
  /** Ids of the additional roles the member has. */
  roleIds: readonly string[];
}

/**
 * Applies one layer of overwrites in the canonical order: @everyone, then the member's roles
 * (all denies before all allows, so any role that allows wins), then the member itself.
 */
export function applyOverwrites(
  permissions: bigint,
  overwrites: readonly PermissionOverwrite[],
  context: OverwriteContext,
): bigint {
  let result = permissions;

  const everyone = overwrites.find(
    (overwrite) => overwrite.targetType === 'role' && overwrite.targetId === context.everyoneRoleId,
  );
  if (everyone) result = (result & ~everyone.deny) | everyone.allow;

  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const overwrite of overwrites) {
    if (
      overwrite.targetType === 'role' &&
      overwrite.targetId !== context.everyoneRoleId &&
      context.roleIds.includes(overwrite.targetId)
    ) {
      roleAllow |= overwrite.allow;
      roleDeny |= overwrite.deny;
    }
  }
  result = (result & ~roleDeny) | roleAllow;

  const member = overwrites.find(
    (overwrite) => overwrite.targetType === 'member' && overwrite.targetId === context.userId,
  );
  if (member) result = (result & ~member.deny) | member.allow;

  return result;
}

export interface ChannelPermissionInput extends OverwriteContext {
  /** Result of `computeBasePermissions`. */
  basePermissions: bigint;
  channelType: 'text' | 'voice' | 'category';
  /** Overwrites of the parent category, applied before the channel's own. */
  categoryOverwrites?: readonly PermissionOverwrite[];
  channelOverwrites: readonly PermissionOverwrite[];
}

/**
 * Effective permissions of a member in a channel.
 *
 * Owners and administrators always get everything. Otherwise the category layer is applied,
 * then the channel layer, and finally the implicit rules: not seeing a channel means having
 * no permission in it, and not being able to connect rules out speaking and streaming.
 */
export function computeChannelPermissions(input: ChannelPermissionInput): bigint {
  if (hasPermission(input.basePermissions, Permissions.Administrator)) return ALL_PERMISSIONS;

  let permissions = input.basePermissions;
  if (input.categoryOverwrites) {
    permissions = applyOverwrites(permissions, input.categoryOverwrites, input);
  }
  permissions = applyOverwrites(permissions, input.channelOverwrites, input);

  // Overwrites cannot hand out administrator.
  permissions &= ~Permissions.Administrator;

  if (!hasPermission(permissions, Permissions.ViewChannel)) return 0n;
  // Voice channels have a text chat of their own, so the text permissions apply there too.
  if (input.channelType !== 'voice') {
    permissions &= ~(VOICE_ONLY | Permissions.Connect);
  } else if (!hasPermission(permissions, Permissions.Connect)) {
    permissions &= ~VOICE_ONLY;
  }
  return permissions;
}

// --- role hierarchy -------------------------------------------------------------------------

export interface HierarchyActor {
  isOwner: boolean;
  /** Server-wide permissions (`computeBasePermissions`). */
  permissions: bigint;
  /** Position of the actor's highest role; 0 when they only have @everyone. */
  highestRolePosition: number;
}

export function highestRolePosition(roles: ReadonlyArray<{ position: number }>): number {
  return roles.reduce((highest, role) => Math.max(highest, role.position), 0);
}

/**
 * Whether the actor may edit, delete or assign a role. Requires ManageRoles and the role to
 * sit strictly below the actor's highest role. @everyone (position 0) has no rank, so it is
 * editable by anyone who holds ManageRoles.
 */
export function canManageRole(
  actor: HierarchyActor,
  role: { position: number; isEveryone: boolean },
): boolean {
  if (actor.isOwner) return true;
  if (!hasPermission(actor.permissions, Permissions.ManageRoles)) return false;
  if (role.isEveryone) return true;
  return role.position < actor.highestRolePosition;
}

/** A member can only hand out permissions they hold themselves. */
export function canGrantPermissions(actor: HierarchyActor, requested: bigint): boolean {
  if (actor.isOwner) return true;
  return (requested & ~actor.permissions) === 0n;
}

/**
 * Whether the actor outranks the target for moderation (kick, role assignment). The owner is
 * untouchable, and equals cannot act on each other.
 */
export function outranks(
  actor: HierarchyActor,
  target: { isOwner: boolean; highestRolePosition: number },
): boolean {
  if (target.isOwner) return false;
  if (actor.isOwner) return true;
  return actor.highestRolePosition > target.highestRolePosition;
}
