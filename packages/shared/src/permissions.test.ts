import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  applyOverwrites,
  canGrantPermissions,
  canManageRole,
  computeBasePermissions,
  computeChannelPermissions,
  DEFAULT_EVERYONE_PERMISSIONS,
  hasPermission,
  highestRolePosition,
  outranks,
  parsePermissions,
  permissionBitsSchema,
  Permissions as P,
  serializePermissions,
  type ChannelPermissionInput,
  type HierarchyActor,
  type PermissionOverwrite,
} from './permissions';

const GUILD = 'guild-1'; // also the id of @everyone
const USER = 'user-1';
const MOD = 'role-mod';
const MUTED = 'role-muted';
const VIP = 'role-vip';

const role = (targetId: string, allow: bigint, deny: bigint): PermissionOverwrite => ({
  targetType: 'role',
  targetId,
  allow,
  deny,
});
const member = (targetId: string, allow: bigint, deny: bigint): PermissionOverwrite => ({
  targetType: 'member',
  targetId,
  allow,
  deny,
});

function channel(overrides: Partial<ChannelPermissionInput> = {}): bigint {
  return computeChannelPermissions({
    userId: USER,
    everyoneRoleId: GUILD,
    roleIds: [],
    basePermissions: DEFAULT_EVERYONE_PERMISSIONS,
    channelType: 'text',
    channelOverwrites: [],
    ...overrides,
  });
}

describe('bit helpers', () => {
  it('uses a distinct bit for every permission', () => {
    const bits = Object.values(P);
    expect(new Set(bits).size).toBe(bits.length);
    for (const bit of bits) expect(bit & (bit - 1n)).toBe(0n);
  });

  it('requires every requested bit', () => {
    const permissions = P.ViewChannel | P.SendMessages;
    expect(hasPermission(permissions, P.ViewChannel)).toBe(true);
    expect(hasPermission(permissions, P.ViewChannel | P.SendMessages)).toBe(true);
    expect(hasPermission(permissions, P.ViewChannel | P.Connect)).toBe(false);
    expect(hasPermission(permissions, 0n)).toBe(true);
  });

  it('round-trips through the wire format', () => {
    const wire = serializePermissions(DEFAULT_EVERYONE_PERMISSIONS);
    expect(permissionBitsSchema.parse(wire)).toBe(wire);
    expect(parsePermissions(wire)).toBe(DEFAULT_EVERYONE_PERMISSIONS);
  });

  it('rejects malformed values and unknown bits', () => {
    expect(permissionBitsSchema.safeParse('-1').success).toBe(false);
    expect(permissionBitsSchema.safeParse('0x10').success).toBe(false);
    expect(permissionBitsSchema.safeParse('').success).toBe(false);
    expect(permissionBitsSchema.safeParse((ALL_PERMISSIONS + 1n).toString()).success).toBe(false);
    expect(permissionBitsSchema.safeParse(ALL_PERMISSIONS.toString()).success).toBe(true);
  });
});

describe('computeBasePermissions', () => {
  it('gives the owner everything regardless of roles', () => {
    expect(
      computeBasePermissions({ isOwner: true, everyonePermissions: 0n, rolePermissions: [] }),
    ).toBe(ALL_PERMISSIONS);
  });

  it('starts from @everyone when the member has no roles', () => {
    expect(
      computeBasePermissions({
        isOwner: false,
        everyonePermissions: P.ViewChannel | P.Connect,
        rolePermissions: [],
      }),
    ).toBe(P.ViewChannel | P.Connect);
  });

  it('unions every role with @everyone', () => {
    expect(
      computeBasePermissions({
        isOwner: false,
        everyonePermissions: P.ViewChannel,
        rolePermissions: [P.KickMembers, P.ManageChannels | P.ViewChannel],
      }),
    ).toBe(P.ViewChannel | P.KickMembers | P.ManageChannels);
  });

  it('expands administrator to every permission', () => {
    expect(
      computeBasePermissions({
        isOwner: false,
        everyonePermissions: 0n,
        rolePermissions: [P.Administrator],
      }),
    ).toBe(ALL_PERMISSIONS);
  });

  it('expands administrator granted through @everyone too', () => {
    expect(
      computeBasePermissions({
        isOwner: false,
        everyonePermissions: P.Administrator,
        rolePermissions: [],
      }),
    ).toBe(ALL_PERMISSIONS);
  });

  it('has no permissions when nothing grants any', () => {
    expect(
      computeBasePermissions({ isOwner: false, everyonePermissions: 0n, rolePermissions: [0n] }),
    ).toBe(0n);
  });
});

describe('applyOverwrites', () => {
  const context = { userId: USER, everyoneRoleId: GUILD, roleIds: [MOD, MUTED] };

  it('returns the input untouched when there are no overwrites', () => {
    expect(applyOverwrites(P.ViewChannel, [], context)).toBe(P.ViewChannel);
  });

  it('applies the @everyone overwrite to everybody', () => {
    const result = applyOverwrites(
      P.ViewChannel | P.SendMessages,
      [role(GUILD, P.Connect, P.SendMessages)],
      context,
    );
    expect(result).toBe(P.ViewChannel | P.Connect);
  });

  it('ignores overwrites for roles the member does not have', () => {
    const result = applyOverwrites(P.ViewChannel, [role(VIP, P.Stream, P.ViewChannel)], context);
    expect(result).toBe(P.ViewChannel);
  });

  it('ignores overwrites for other members', () => {
    const result = applyOverwrites(P.ViewChannel, [member('user-2', 0n, P.ViewChannel)], context);
    expect(result).toBe(P.ViewChannel);
  });

  it('lets a role allow win over another role deny', () => {
    const result = applyOverwrites(
      P.ViewChannel,
      [role(MUTED, 0n, P.SendMessages), role(MOD, P.SendMessages, 0n)],
      context,
    );
    expect(hasPermission(result, P.SendMessages)).toBe(true);
  });

  it('lets a role overwrite restore what @everyone denied', () => {
    const result = applyOverwrites(
      P.ViewChannel,
      [role(GUILD, 0n, P.ViewChannel), role(MOD, P.ViewChannel, 0n)],
      context,
    );
    expect(hasPermission(result, P.ViewChannel)).toBe(true);
  });

  it('lets a member overwrite beat every role overwrite', () => {
    const allowedByRole = applyOverwrites(
      0n,
      [role(MOD, P.SendMessages, 0n), member(USER, 0n, P.SendMessages)],
      context,
    );
    expect(hasPermission(allowedByRole, P.SendMessages)).toBe(false);

    const deniedByRole = applyOverwrites(
      P.SendMessages,
      [role(MUTED, 0n, P.SendMessages), member(USER, P.SendMessages, 0n)],
      context,
    );
    expect(hasPermission(deniedByRole, P.SendMessages)).toBe(true);
  });

  it('treats a member id equal to a role id as different targets', () => {
    const result = applyOverwrites(P.ViewChannel, [member(MOD, 0n, P.ViewChannel)], context);
    expect(result).toBe(P.ViewChannel);
  });

  it('gives allow precedence when one overwrite both allows and denies a bit', () => {
    const result = applyOverwrites(0n, [role(GUILD, P.Speak, P.Speak)], context);
    expect(hasPermission(result, P.Speak)).toBe(true);
  });
});

describe('computeChannelPermissions', () => {
  it('passes base permissions through when the channel has no overwrites', () => {
    expect(channel({ channelType: 'voice' })).toBe(DEFAULT_EVERYONE_PERMISSIONS);
  });

  it('never restricts administrators or owners', () => {
    const lockedDown = [role(GUILD, 0n, ALL_PERMISSIONS), member(USER, 0n, ALL_PERMISSIONS)];
    expect(channel({ basePermissions: ALL_PERMISSIONS, channelOverwrites: lockedDown })).toBe(
      ALL_PERMISSIONS,
    );
  });

  it('hides a private channel from members without the allowed role', () => {
    const overwrites = [role(GUILD, 0n, P.ViewChannel), role(VIP, P.ViewChannel, 0n)];
    expect(channel({ channelOverwrites: overwrites })).toBe(0n);
    expect(
      hasPermission(channel({ channelOverwrites: overwrites, roleIds: [VIP] }), P.ViewChannel),
    ).toBe(true);
  });

  it('strips everything when the channel cannot be viewed', () => {
    const result = channel({
      basePermissions: P.SendMessages | P.ManageMessages | P.ManageChannels,
    });
    expect(result).toBe(0n);
  });

  it('removes speak and stream when connect is denied in a voice channel', () => {
    const result = channel({
      channelType: 'voice',
      channelOverwrites: [role(GUILD, 0n, P.Connect)],
    });
    expect(hasPermission(result, P.ViewChannel)).toBe(true);
    expect(result & (P.Connect | P.Speak | P.Stream)).toBe(0n);
  });

  it('supports listen-only voice channels', () => {
    const result = channel({
      channelType: 'voice',
      channelOverwrites: [role(GUILD, 0n, P.Speak | P.Stream)],
    });
    expect(hasPermission(result, P.Connect)).toBe(true);
    expect(result & (P.Speak | P.Stream)).toBe(0n);
  });

  it('lets a role unlock streaming in a channel where @everyone cannot stream', () => {
    const overwrites = [role(GUILD, 0n, P.Stream), role(VIP, P.Stream, 0n)];
    expect(
      hasPermission(channel({ channelType: 'voice', channelOverwrites: overwrites }), P.Stream),
    ).toBe(false);
    expect(
      hasPermission(
        channel({ channelType: 'voice', channelOverwrites: overwrites, roleIds: [VIP] }),
        P.Stream,
      ),
    ).toBe(true);
  });

  it('drops voice permissions in text channels', () => {
    expect(channel({ channelType: 'text' }) & (P.Connect | P.Speak | P.Stream)).toBe(0n);
  });

  it('supports read-only text channels with an exception for one member', () => {
    const overwrites = [role(GUILD, 0n, P.SendMessages), member(USER, P.SendMessages, 0n)];
    expect(hasPermission(channel({ channelOverwrites: overwrites }), P.SendMessages)).toBe(true);
    expect(
      hasPermission(channel({ channelOverwrites: overwrites, userId: 'user-2' }), P.SendMessages),
    ).toBe(false);
  });

  it('cannot grant administrator through an overwrite', () => {
    const result = channel({ channelOverwrites: [member(USER, P.Administrator, 0n)] });
    expect(hasPermission(result, P.Administrator)).toBe(false);
    expect(result).not.toBe(ALL_PERMISSIONS);
  });

  it('can grant a moderation permission in a single channel', () => {
    const result = channel({
      channelOverwrites: [role(MOD, P.ManageMessages, 0n)],
      roleIds: [MOD],
    });
    expect(hasPermission(result, P.ManageMessages)).toBe(true);
  });

  describe('category inheritance', () => {
    const privateCategory = [role(GUILD, 0n, P.ViewChannel), role(VIP, P.ViewChannel, 0n)];

    it('applies the category overwrites to its channels', () => {
      expect(channel({ categoryOverwrites: privateCategory })).toBe(0n);
      expect(
        hasPermission(
          channel({ categoryOverwrites: privateCategory, roleIds: [VIP] }),
          P.ViewChannel,
        ),
      ).toBe(true);
    });

    it('lets the channel override its category', () => {
      const result = channel({
        categoryOverwrites: privateCategory,
        channelOverwrites: [role(GUILD, P.ViewChannel, 0n)],
      });
      expect(hasPermission(result, P.ViewChannel)).toBe(true);
    });

    it('lets the channel restrict further than its category', () => {
      const result = channel({
        categoryOverwrites: [role(VIP, P.ManageMessages, 0n)],
        channelOverwrites: [role(VIP, 0n, P.ManageMessages | P.SendMessages)],
        roleIds: [VIP],
      });
      expect(result & (P.ManageMessages | P.SendMessages)).toBe(0n);
      expect(hasPermission(result, P.ViewChannel)).toBe(true);
    });

    it('keeps a category member overwrite unless the channel says otherwise', () => {
      const result = channel({
        categoryOverwrites: [member(USER, 0n, P.SendMessages)],
        channelOverwrites: [role(GUILD, P.MentionEveryone, 0n)],
      });
      expect(hasPermission(result, P.SendMessages)).toBe(false);
      expect(hasPermission(result, P.MentionEveryone)).toBe(true);
    });
  });
});

describe('role hierarchy', () => {
  const actor = (overrides: Partial<HierarchyActor> = {}): HierarchyActor => ({
    isOwner: false,
    permissions: P.ManageRoles | P.KickMembers | P.ViewChannel,
    highestRolePosition: 5,
    ...overrides,
  });
  const everyone = { position: 0, isEveryone: true };

  it('finds the highest role, defaulting to @everyone', () => {
    expect(highestRolePosition([])).toBe(0);
    expect(highestRolePosition([{ position: 2 }, { position: 7 }, { position: 4 }])).toBe(7);
  });

  describe('canManageRole', () => {
    it('allows roles strictly below the actor', () => {
      expect(canManageRole(actor(), { position: 4, isEveryone: false })).toBe(true);
    });

    it('refuses the actor own highest role and anything above it', () => {
      expect(canManageRole(actor(), { position: 5, isEveryone: false })).toBe(false);
      expect(canManageRole(actor(), { position: 9, isEveryone: false })).toBe(false);
    });

    it('requires the ManageRoles permission', () => {
      expect(
        canManageRole(actor({ permissions: P.KickMembers }), { position: 1, isEveryone: false }),
      ).toBe(false);
    });

    it('lets the owner manage any role', () => {
      expect(
        canManageRole(actor({ isOwner: true, permissions: 0n, highestRolePosition: 0 }), {
          position: 99,
          isEveryone: false,
        }),
      ).toBe(true);
    });

    it('lets anyone with ManageRoles edit @everyone, even with no other role', () => {
      expect(canManageRole(actor({ highestRolePosition: 0 }), everyone)).toBe(true);
      expect(canManageRole(actor({ permissions: 0n }), everyone)).toBe(false);
    });

    it('does not let administrators bypass the hierarchy', () => {
      expect(
        canManageRole(actor({ permissions: ALL_PERMISSIONS, highestRolePosition: 3 }), {
          position: 3,
          isEveryone: false,
        }),
      ).toBe(false);
    });
  });

  describe('canGrantPermissions', () => {
    it('allows granting a subset of the actor own permissions', () => {
      expect(canGrantPermissions(actor(), P.KickMembers | P.ViewChannel)).toBe(true);
      expect(canGrantPermissions(actor(), 0n)).toBe(true);
    });

    it('refuses permissions the actor does not hold', () => {
      expect(canGrantPermissions(actor(), P.ManageGuild)).toBe(false);
      expect(canGrantPermissions(actor(), P.KickMembers | P.Administrator)).toBe(false);
    });

    it('lets the owner grant anything', () => {
      expect(canGrantPermissions(actor({ isOwner: true, permissions: 0n }), ALL_PERMISSIONS)).toBe(
        true,
      );
    });
  });

  describe('outranks', () => {
    it('requires a strictly higher role', () => {
      expect(outranks(actor(), { isOwner: false, highestRolePosition: 4 })).toBe(true);
      expect(outranks(actor(), { isOwner: false, highestRolePosition: 5 })).toBe(false);
      expect(outranks(actor(), { isOwner: false, highestRolePosition: 6 })).toBe(false);
    });

    it('never lets anyone act on the owner', () => {
      expect(
        outranks(actor({ highestRolePosition: 99 }), { isOwner: true, highestRolePosition: 0 }),
      ).toBe(false);
    });

    it('lets the owner act on anyone else', () => {
      expect(
        outranks(actor({ isOwner: true, highestRolePosition: 0 }), {
          isOwner: false,
          highestRolePosition: 99,
        }),
      ).toBe(true);
    });

    it('does not let two members without roles act on each other', () => {
      expect(
        outranks(actor({ highestRolePosition: 0 }), { isOwner: false, highestRolePosition: 0 }),
      ).toBe(false);
    });
  });
});
