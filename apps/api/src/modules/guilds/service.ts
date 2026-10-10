import { randomUUID } from 'node:crypto';
import type { ReadStream } from 'node:fs';
import {
  ApiErrorCode,
  GUILD_SOUND_MAX_BYTES,
  canGrantPermissions,
  canManageRole,
  DEFAULT_EVERYONE_PERMISSIONS,
  hasPermission,
  outranks,
  parsePermissions,
  Permissions,
  type Ban,
  type Channel,
  type ChannelType,
  type Guild,
  type GuildSound,
  type GuildSoundEvent,
  type GuildSummary,
  type Invite,
  type InvitePreview,
  type Member,
  type PutOverwriteRequest,
  type Role,
} from '@frequencia/shared';
import { and, count, eq, gt, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { schema, type Database, type Queryable } from '../../db/client';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../errors';
import type { GatewayBus } from '../../gateway/bus';
import { sniffAudio } from '../../lib/audio';
import { cleanFilename } from '../../lib/filename';
import { inviteCode, uuidv7 } from '../../lib/ids';
import { toPublicUser } from '../../lib/user';
import type { PictureStore } from '../users/pictures';
import type { AttachmentFiles } from '../messages/attachment-files';
import type { VoiceAccess } from '../voice/voice-access';
import { buildGuildPayload, type LiveState } from './live';
import {
  actorOf,
  canViewChannel,
  channelPermissionsOf,
  loadGuildSnapshot,
  requireActor,
  requirePermission,
  toChannel,
  toMember,
  toRole,
  type Actor,
  type GuildSnapshot,
} from './snapshot';

const {
  guilds,
  roles,
  channels,
  channelOverwrites,
  guildMembers,
  memberRoles,
  invites,
  guildSounds,
  guildBans,
  users,
} = schema;

export interface GuildServiceDeps {
  db: Database;
  bus: GatewayBus;
  live: LiveState;
  voice: VoiceAccess;
  /** Where the custom notification sounds of guilds are stored. */
  soundFiles: AttachmentFiles;
  /** Server icons (shared with profile pictures). */
  pictures: PictureStore;
}

/**
 * Guilds, channels, roles, members and invites. Every method takes the acting user, checks
 * permissions against a fresh snapshot, writes, and then tells the gateway what changed.
 */
export class GuildService {
  constructor(private readonly deps: GuildServiceDeps) {}

  private get db() {
    return this.deps.db;
  }

  private get bus() {
    return this.deps.bus;
  }

  // --- guilds -------------------------------------------------------------------------------

  async list(userId: string): Promise<GuildSummary[]> {
    return this.db
      .select({ id: guilds.id, name: guilds.name, icon: guilds.iconId, ownerId: guilds.ownerId })
      .from(guilds)
      .innerJoin(guildMembers, eq(guildMembers.guildId, guilds.id))
      .where(eq(guildMembers.userId, userId))
      .orderBy(guildMembers.joinedAt);
  }

  async get(userId: string, guildId: string): Promise<Guild> {
    const snapshot = await this.load(guildId);
    requireActor(snapshot, userId);
    return buildGuildPayload(this.deps.live, snapshot, userId);
  }

  async create(userId: string, name: string): Promise<Guild> {
    const guildId = uuidv7();
    await this.db.transaction(async (tx) => {
      await tx.insert(guilds).values({ id: guildId, name, ownerId: userId });
      await tx.insert(guildMembers).values({ guildId, userId });
      // @everyone shares its id with the guild.
      await tx.insert(roles).values({
        id: guildId,
        guildId,
        name: '@everyone',
        permissions: DEFAULT_EVERYONE_PERMISSIONS,
        position: 0,
      });
      const textCategory = uuidv7();
      const voiceCategory = uuidv7();
      await tx.insert(channels).values([
        { id: textCategory, guildId, type: 'category', name: 'Texto', position: 0 },
        { id: voiceCategory, guildId, type: 'category', name: 'Voz', position: 1 },
        { id: uuidv7(), guildId, type: 'text', name: 'geral', position: 0, parentId: textCategory },
        {
          id: uuidv7(),
          guildId,
          type: 'voice',
          name: 'Geral',
          position: 0,
          parentId: voiceCategory,
        },
      ]);
    });
    await this.bus.publish({ kind: 'guild-join', guildId, userId });
    return this.get(userId, guildId);
  }

  async rename(userId: string, guildId: string, name: string): Promise<GuildSummary> {
    const snapshot = await this.load(guildId);
    requirePermission(requireActor(snapshot, userId), Permissions.ManageGuild);
    await this.db.update(guilds).set({ name }).where(eq(guilds.id, guildId));
    const icon = snapshot.guild.iconId;
    await this.bus.event(guildId, 'GUILD_UPDATE', { id: guildId, name, icon });
    return { id: guildId, name, icon, ownerId: snapshot.guild.ownerId };
  }

  /** Sets the server icon (MANAGE_GUILD), or removes it with `null`. */
  async setIcon(userId: string, guildId: string, data: Buffer | null): Promise<GuildSummary> {
    const snapshot = await this.load(guildId);
    requirePermission(requireActor(snapshot, userId), Permissions.ManageGuild);
    const icon = data ? await this.deps.pictures.store(data) : null;
    await this.db.update(guilds).set({ iconId: icon }).where(eq(guilds.id, guildId));
    await this.deps.pictures.discard(snapshot.guild.iconId);
    const { name, ownerId } = snapshot.guild;
    await this.bus.event(guildId, 'GUILD_UPDATE', { id: guildId, name, icon });
    return { id: guildId, name, icon, ownerId };
  }

  async delete(userId: string, guildId: string): Promise<void> {
    const snapshot = await this.load(guildId);
    if (!requireActor(snapshot, userId).isOwner) throw forbidden('only the owner can delete');
    await this.db.delete(guilds).where(eq(guilds.id, guildId));
    await this.deps.soundFiles.remove([...snapshot.sounds.values()].map((sound) => sound.id));
    await this.deps.pictures.discard(snapshot.guild.iconId);
    await this.bus.publish({ kind: 'guild-delete', guildId });
    await Promise.all(
      [...snapshot.channels.values()]
        .filter((channel) => channel.type === 'voice')
        .map((channel) => this.deps.voice.closeChannel(channel.id)),
    );
  }

  // --- notification sounds ------------------------------------------------------------------

  /**
   * Replaces the sound every member hears for an event. Only the owner decides; the type comes
   * from the bytes of the file.
   */
  async setSound(
    userId: string,
    guildId: string,
    event: GuildSoundEvent,
    filename: string,
    data: Buffer,
  ): Promise<GuildSound> {
    const snapshot = await this.load(guildId);
    if (!requireActor(snapshot, userId).isOwner) {
      throw forbidden('only the owner can change the sounds');
    }
    if (data.length === 0 || data.length > GUILD_SOUND_MAX_BYTES) {
      throw badRequest('sound is empty or too large');
    }
    const contentType = sniffAudio(data);
    if (!contentType) throw badRequest('only MP3, WAV, Ogg, FLAC, M4A and WebM audio is accepted');

    const sound = { id: randomUUID(), filename: cleanFilename(filename, 'som') };
    await this.deps.soundFiles.write(sound.id, data);
    try {
      const values = { fileId: sound.id, filename: sound.filename, contentType, size: data.length };
      await this.db
        .insert(guildSounds)
        .values({ guildId, event, ...values })
        .onConflictDoUpdate({ target: [guildSounds.guildId, guildSounds.event], set: values });
    } catch (error) {
      await this.deps.soundFiles.remove([sound.id]);
      throw error;
    }
    const previous = snapshot.sounds.get(event);
    if (previous) await this.deps.soundFiles.remove([previous.id]);
    await this.bus.sync(guildId);
    return sound;
  }

  /** Back to the built-in sound. Owner only. */
  async clearSound(userId: string, guildId: string, event: GuildSoundEvent): Promise<void> {
    const snapshot = await this.load(guildId);
    if (!requireActor(snapshot, userId).isOwner) {
      throw forbidden('only the owner can change the sounds');
    }
    const previous = snapshot.sounds.get(event);
    if (!previous) return;
    await this.db
      .delete(guildSounds)
      .where(and(eq(guildSounds.guildId, guildId), eq(guildSounds.event, event)));
    await this.deps.soundFiles.remove([previous.id]);
    await this.bus.sync(guildId);
  }

  /** The file of a guild sound, for any member of the guild. */
  async sound(
    userId: string,
    guildId: string,
    event: GuildSoundEvent,
  ): Promise<{ contentType: string; size: number; stream: ReadStream }> {
    requireActor(await this.load(guildId), userId);
    const [row] = await this.db
      .select()
      .from(guildSounds)
      .where(and(eq(guildSounds.guildId, guildId), eq(guildSounds.event, event)));
    if (!row) throw notFound('sound');
    return {
      contentType: row.contentType,
      size: row.size,
      stream: this.deps.soundFiles.open(row.fileId),
    };
  }

  // --- members ------------------------------------------------------------------------------

  async leave(userId: string, guildId: string): Promise<void> {
    const snapshot = await this.load(guildId);
    if (requireActor(snapshot, userId).isOwner) {
      throw conflict('the owner cannot leave; delete the server or transfer it first');
    }
    await this.removeMember(guildId, userId);
  }

  async kick(actorId: string, guildId: string, targetId: string): Promise<void> {
    const snapshot = await this.load(guildId);
    const actor = requireActor(snapshot, actorId);
    requirePermission(actor, Permissions.KickMembers);
    const target = actorOf(snapshot, targetId);
    if (!target) throw notFound('member');
    if (targetId === actorId) throw badRequest('use leave to remove yourself');
    if (!outranks(actor, target)) throw forbidden('the member has an equal or higher role');
    await this.removeMember(guildId, targetId);
  }

  async updateMember(
    actorId: string,
    guildId: string,
    targetId: string,
    changes: { roleIds?: string[]; nickname?: string | null; serverMuted?: boolean },
  ): Promise<Member> {
    const snapshot = await this.load(guildId);
    const actor = requireActor(snapshot, actorId);
    const target = actorOf(snapshot, targetId);
    if (!target) throw notFound('member');

    if (changes.nickname !== undefined) {
      if (targetId !== actorId) {
        requirePermission(actor, Permissions.ManageGuild);
        if (!outranks(actor, target)) throw forbidden('the member has an equal or higher role');
      }
      await this.db
        .update(guildMembers)
        .set({ nickname: changes.nickname })
        .where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, targetId)));
    }

    let voiceChanged = false;
    if (changes.serverMuted !== undefined && changes.serverMuted !== target.member.serverMuted) {
      requirePermission(actor, Permissions.MuteMembers);
      // Anyone with the permission may lift a mute from themselves, never impose on a superior.
      if (targetId !== actorId && !outranks(actor, target)) {
        throw forbidden('the member has an equal or higher role');
      }
      await this.db
        .update(guildMembers)
        .set({ serverMuted: changes.serverMuted })
        .where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, targetId)));
      voiceChanged = true;
    }

    let rolesChanged = false;
    if (changes.roleIds !== undefined) {
      requirePermission(actor, Permissions.ManageRoles);
      const wanted = new Set(changes.roleIds);
      const current = new Set(target.member.roleIds);
      const touched = [...wanted].filter((id) => !current.has(id));
      touched.push(...[...current].filter((id) => !wanted.has(id)));

      for (const roleId of touched) {
        const role = snapshot.roles.get(roleId);
        if (!role || role.id === guildId) throw badRequest('unknown role');
        // Only roles below the actor's own may be handed out or taken away.
        if (!canManageRole(actor, { position: role.position, isEveryone: false })) {
          throw forbidden(`role "${role.name}" is not below your highest role`);
        }
      }
      if (touched.length > 0) {
        rolesChanged = true;
        await this.db.transaction(async (tx) => {
          await tx
            .delete(memberRoles)
            .where(and(eq(memberRoles.guildId, guildId), eq(memberRoles.userId, targetId)));
          if (wanted.size > 0) {
            await tx
              .insert(memberRoles)
              .values([...wanted].map((roleId) => ({ guildId, userId: targetId, roleId })));
          }
        });
      }
    }

    const updated = (await this.load(guildId)).members.get(targetId);
    if (!updated) throw notFound('member');
    const member = toMember(updated);
    await this.bus.event(guildId, 'MEMBER_UPDATE', { guildId, member });
    if (rolesChanged) await this.permissionsChanged(guildId);
    // The microphone right travels in the voice token: whoever is in a call rejoins with a new one.
    else if (voiceChanged) await this.deps.voice.enforce(guildId);
    return member;
  }

  /** Takes a member out of the voice channel they are in (DISCONNECT_MEMBERS). */
  async disconnectFromVoice(actorId: string, guildId: string, targetId: string): Promise<void> {
    const snapshot = await this.load(guildId);
    const actor = requireActor(snapshot, actorId);
    requirePermission(actor, Permissions.DisconnectMembers);
    const target = actorOf(snapshot, targetId);
    if (!target) throw notFound('member');
    if (targetId !== actorId && !outranks(actor, target)) {
      throw forbidden('the member has an equal or higher role');
    }
    if (!(await this.deps.voice.kick(guildId, targetId))) throw notFound('voice connection');
  }

  // --- bans ---------------------------------------------------------------------------------

  /** Removes a member and keeps them from coming back with an invite (BAN_MEMBERS). */
  async ban(actorId: string, guildId: string, targetId: string): Promise<void> {
    const snapshot = await this.load(guildId);
    const actor = requireActor(snapshot, actorId);
    requirePermission(actor, Permissions.BanMembers);
    if (targetId === actorId) throw badRequest('you cannot ban yourself');
    const target = actorOf(snapshot, targetId);
    // Someone who already left can still be banned, as long as the account exists.
    if (target) {
      if (!outranks(actor, target)) throw forbidden('the member has an equal or higher role');
    } else {
      const [user] = await this.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, targetId));
      if (!user) throw notFound('user');
    }
    await this.db
      .insert(guildBans)
      .values({ guildId, userId: targetId, bannedBy: actorId })
      .onConflictDoNothing();
    if (target) await this.removeMember(guildId, targetId);
  }

  async unban(actorId: string, guildId: string, targetId: string): Promise<void> {
    const snapshot = await this.load(guildId);
    requirePermission(requireActor(snapshot, actorId), Permissions.BanMembers);
    const removed = await this.db
      .delete(guildBans)
      .where(and(eq(guildBans.guildId, guildId), eq(guildBans.userId, targetId)))
      .returning();
    if (removed.length === 0) throw notFound('ban');
  }

  async listBans(actorId: string, guildId: string): Promise<Ban[]> {
    const snapshot = await this.load(guildId);
    requirePermission(requireActor(snapshot, actorId), Permissions.BanMembers);
    const rows = await this.db
      .select({ ban: guildBans, user: users })
      .from(guildBans)
      .innerJoin(users, eq(users.id, guildBans.userId))
      .where(eq(guildBans.guildId, guildId))
      .orderBy(guildBans.createdAt);
    return rows.map(({ ban, user }) => ({
      user: toPublicUser(user),
      bannedBy: ban.bannedBy,
      createdAt: ban.createdAt.toISOString(),
    }));
  }

  // --- channels -----------------------------------------------------------------------------

  async createChannel(
    userId: string,
    guildId: string,
    input: { name: string; type: Exclude<ChannelType, 'thread'>; parentId?: string | null },
  ): Promise<Channel> {
    const snapshot = await this.load(guildId);
    requirePermission(requireActor(snapshot, userId), Permissions.ManageChannels);
    const parentId = this.validateParent(snapshot, input.type, input.parentId ?? null);

    const siblings = [...snapshot.channels.values()].filter(
      (channel) =>
        channel.parentId === parentId &&
        (channel.type === 'category') === (input.type === 'category'),
    );
    const id = uuidv7();
    await this.db.insert(channels).values({
      id,
      guildId,
      type: input.type,
      name: input.name,
      parentId,
      position: siblings.reduce((max, channel) => Math.max(max, channel.position + 1), 0),
    });

    const created = await this.channelPayload(guildId, id);
    await this.bus.event(guildId, 'CHANNEL_CREATE', created, id);
    return created;
  }

  /** Opens a thread under a text channel; anyone who can write there may (SEND_MESSAGES). */
  async createThread(userId: string, parentId: string, name: string): Promise<Channel> {
    const { snapshot, channel: parent } = await this.loadChannel(parentId);
    this.requireChannelPermission(snapshot, userId, parentId, Permissions.SendMessages);
    if (parent.type !== 'text') throw badRequest('threads hang from text channels');

    const siblings = [...snapshot.channels.values()].filter(
      (channel) => channel.type === 'thread' && channel.parentId === parentId,
    );
    const id = uuidv7();
    await this.db.insert(channels).values({
      id,
      guildId: parent.guildId,
      type: 'thread',
      name,
      parentId,
      position: siblings.reduce((max, channel) => Math.max(max, channel.position + 1), 0),
    });
    const created = await this.channelPayload(parent.guildId, id);
    await this.bus.event(parent.guildId, 'CHANNEL_CREATE', created, id);
    return created;
  }

  async updateChannel(
    userId: string,
    channelId: string,
    changes: { name?: string; topic?: string | null; parentId?: string | null },
  ): Promise<Channel> {
    const { snapshot, channel } = await this.loadChannel(channelId);
    this.requireChannelPermission(snapshot, userId, channelId, Permissions.ManageChannels);
    if (channel.type === 'thread' && changes.parentId !== undefined) {
      throw badRequest('a thread stays in its channel');
    }

    const parentId =
      changes.parentId === undefined
        ? undefined
        : this.validateParent(snapshot, channel.type, changes.parentId);
    await this.db
      .update(channels)
      .set({ name: changes.name, topic: changes.topic, parentId })
      .where(eq(channels.id, channelId));

    const updated = await this.channelPayload(channel.guildId, channelId);
    if (parentId !== undefined && parentId !== channel.parentId) {
      // Moving between categories changes inherited overwrites, hence who can see it.
      await this.permissionsChanged(channel.guildId);
    } else {
      await this.bus.event(channel.guildId, 'CHANNEL_UPDATE', updated, channelId);
    }
    return updated;
  }

  async deleteChannel(userId: string, channelId: string): Promise<void> {
    const { snapshot, channel } = await this.loadChannel(channelId);
    this.requireChannelPermission(snapshot, userId, channelId, Permissions.ManageChannels);

    // Once the row is gone nobody can tell who could see it, so the audience is fixed now.
    const viewers = [...snapshot.members.keys()].filter((memberId) =>
      canViewChannel(snapshot, memberId, channelId),
    );
    // Threads go with their channel; the same people could see them.
    const threads = [...snapshot.channels.values()].filter(
      (entry) => entry.type === 'thread' && entry.parentId === channelId,
    );
    await this.db
      .delete(channels)
      .where(inArray(channels.id, [channelId, ...threads.map((thread) => thread.id)]));
    for (const id of [...threads.map((thread) => thread.id), channelId]) {
      await this.bus.eventTo(channel.guildId, viewers, 'CHANNEL_DELETE', {
        id,
        guildId: channel.guildId,
      });
    }

    if (channel.type === 'voice') await this.deps.voice.closeChannel(channelId);
    // Children of a deleted category lose their inherited overwrites.
    if (channel.type === 'category') await this.permissionsChanged(channel.guildId);
  }

  /** Applies a new ordering: positions follow the array order within each parent. */
  async reorderChannels(
    userId: string,
    guildId: string,
    order: Array<{ id: string; parentId: string | null }>,
  ): Promise<void> {
    const snapshot = await this.load(guildId);
    requirePermission(requireActor(snapshot, userId), Permissions.ManageChannels);

    const seen = new Set<string>();
    const nextPosition = new Map<string, number>();
    const updates: Array<{ id: string; parentId: string | null; position: number }> = [];
    for (const item of order) {
      const channel = snapshot.channels.get(item.id);
      if (!channel || seen.has(item.id)) throw badRequest('unknown or duplicated channel');
      if (channel.type === 'thread') throw badRequest('threads are not reordered');
      seen.add(item.id);
      const parentId = this.validateParent(snapshot, channel.type, item.parentId);
      // Categories and regular channels are ordered independently.
      const group = `${channel.type === 'category' ? 'category' : 'channel'}:${parentId ?? ''}`;
      const position = nextPosition.get(group) ?? 0;
      nextPosition.set(group, position + 1);
      updates.push({ id: item.id, parentId, position });
    }

    await this.db.transaction(async (tx) => {
      for (const update of updates) {
        await tx
          .update(channels)
          .set({ parentId: update.parentId, position: update.position })
          .where(eq(channels.id, update.id));
      }
    });
    await this.permissionsChanged(guildId);
  }

  async putOverwrite(
    userId: string,
    channelId: string,
    targetId: string,
    input: PutOverwriteRequest,
  ): Promise<Channel> {
    const { snapshot, channel } = await this.loadChannel(channelId);
    const actor = requireActor(snapshot, userId);
    this.requireChannelPermission(snapshot, userId, channelId, Permissions.ManageRoles);

    const allow = parsePermissions(input.allow) & ~Permissions.Administrator;
    const deny = parsePermissions(input.deny) & ~Permissions.Administrator;
    // Nobody can toggle, in a channel, a permission they do not hold themselves.
    if (!canGrantPermissions(actor, allow | deny)) {
      throw forbidden('cannot change permissions you do not have');
    }
    if (input.targetType === 'role') {
      const role = snapshot.roles.get(targetId);
      if (!role) throw badRequest('unknown role');
      const isEveryone = role.id === channel.guildId;
      if (!canManageRole(actor, { position: role.position, isEveryone })) {
        throw forbidden(`role "${role.name}" is not below your highest role`);
      }
    } else if (!snapshot.members.has(targetId)) {
      throw badRequest('unknown member');
    }

    await this.db
      .insert(channelOverwrites)
      .values({ channelId, targetType: input.targetType, targetId, allow, deny })
      .onConflictDoUpdate({
        target: [channelOverwrites.channelId, channelOverwrites.targetId],
        set: { targetType: input.targetType, allow, deny },
      });
    await this.permissionsChanged(channel.guildId);
    return this.channelPayload(channel.guildId, channelId);
  }

  async deleteOverwrite(userId: string, channelId: string, targetId: string): Promise<Channel> {
    const { snapshot, channel } = await this.loadChannel(channelId);
    this.requireChannelPermission(snapshot, userId, channelId, Permissions.ManageRoles);
    await this.db
      .delete(channelOverwrites)
      .where(
        and(eq(channelOverwrites.channelId, channelId), eq(channelOverwrites.targetId, targetId)),
      );
    await this.permissionsChanged(channel.guildId);
    return this.channelPayload(channel.guildId, channelId);
  }

  // --- roles --------------------------------------------------------------------------------

  async createRole(
    userId: string,
    guildId: string,
    input: { name: string; permissions: string; color?: string | null },
  ): Promise<Role> {
    const snapshot = await this.load(guildId);
    const actor = requireActor(snapshot, userId);
    requirePermission(actor, Permissions.ManageRoles);
    const permissions = parsePermissions(input.permissions);
    if (!canGrantPermissions(actor, permissions)) {
      throw forbidden('cannot grant permissions you do not have');
    }

    // New roles start at the bottom of the hierarchy, right above @everyone.
    const id = uuidv7();
    const [role] = await this.db.transaction(async (tx) => {
      await tx
        .update(roles)
        .set({ position: sql`${roles.position} + 1` })
        .where(and(eq(roles.guildId, guildId), gte(roles.position, 1)));
      return tx
        .insert(roles)
        .values({
          id,
          guildId,
          name: input.name,
          permissions,
          position: 1,
          color: input.color?.toLowerCase() ?? null,
        })
        .returning();
    });
    if (!role) throw new Error('role insert returned nothing');
    await this.permissionsChanged(guildId);
    return toRole(role);
  }

  async updateRole(
    userId: string,
    roleId: string,
    changes: { name?: string; permissions?: string; color?: string | null },
  ): Promise<Role> {
    const { snapshot, role } = await this.loadRole(roleId);
    const actor = requireActor(snapshot, userId);
    const isEveryone = role.id === role.guildId;
    if (!canManageRole(actor, { position: role.position, isEveryone })) throw forbidden();
    if (isEveryone && changes.name !== undefined && changes.name !== role.name) {
      throw badRequest('@everyone cannot be renamed');
    }

    let permissions: bigint | undefined;
    if (changes.permissions !== undefined) {
      permissions = parsePermissions(changes.permissions);
      // Only the bits being flipped need to be ones the actor holds.
      if (!canGrantPermissions(actor, permissions ^ role.permissions)) {
        throw forbidden('cannot change permissions you do not have');
      }
    }

    const [updated] = await this.db
      .update(roles)
      .set({
        name: changes.name,
        permissions,
        // `undefined` leaves the colour alone; `null` removes it.
        ...(changes.color === undefined ? {} : { color: changes.color?.toLowerCase() ?? null }),
      })
      .where(eq(roles.id, roleId))
      .returning();
    if (!updated) throw notFound('role');
    await this.permissionsChanged(role.guildId);
    return toRole(updated);
  }

  async deleteRole(userId: string, roleId: string): Promise<void> {
    const { snapshot, role } = await this.loadRole(roleId);
    const actor = requireActor(snapshot, userId);
    if (role.id === role.guildId) throw badRequest('@everyone cannot be deleted');
    if (!canManageRole(actor, { position: role.position, isEveryone: false })) throw forbidden();

    await this.db.transaction(async (tx) => {
      await tx.delete(roles).where(eq(roles.id, roleId));
      await tx.delete(channelOverwrites).where(eq(channelOverwrites.targetId, roleId));
      await tx
        .update(roles)
        .set({ position: sql`${roles.position} - 1` })
        .where(and(eq(roles.guildId, role.guildId), gt(roles.position, role.position)));
    });
    await this.permissionsChanged(role.guildId);
  }

  /** Sets the hierarchy from the highest role to the lowest (@everyone stays at 0). */
  async reorderRoles(userId: string, guildId: string, roleIds: string[]): Promise<Role[]> {
    const snapshot = await this.load(guildId);
    const actor = requireActor(snapshot, userId);
    requirePermission(actor, Permissions.ManageRoles);

    const ranked = [...snapshot.roles.values()].filter((role) => role.id !== guildId);
    const rankedIds = new Set(ranked.map((role) => role.id));
    if (
      roleIds.length !== ranked.length ||
      new Set(roleIds).size !== ranked.length ||
      roleIds.some((id) => !rankedIds.has(id))
    ) {
      throw badRequest('the order must list every role exactly once');
    }
    const newPosition = new Map(roleIds.map((id, index) => [id, roleIds.length - index]));
    if (!actor.isOwner) {
      for (const role of ranked) {
        const next = newPosition.get(role.id) ?? role.position;
        const movable = role.position < actor.highestRolePosition;
        // Roles at or above the actor stay put, and nothing may be lifted up to their level.
        if (
          (!movable && next !== role.position) ||
          (movable && next >= actor.highestRolePosition)
        ) {
          throw forbidden('roles can only be reordered below your highest role');
        }
      }
    }

    await this.db.transaction(async (tx) => {
      for (const [id, position] of newPosition) {
        await tx.update(roles).set({ position }).where(eq(roles.id, id));
      }
    });
    await this.permissionsChanged(guildId);
    const updated = await this.load(guildId);
    return [...updated.roles.values()].sort((a, b) => b.position - a.position).map(toRole);
  }

  // --- invites ------------------------------------------------------------------------------

  async createInvite(
    userId: string,
    guildId: string,
    input: { maxUses: number | null; expiresInSeconds: number | null },
  ): Promise<Invite> {
    requirePermission(requireActor(await this.load(guildId), userId), Permissions.CreateInvite);
    const [invite] = await this.db
      .insert(invites)
      .values({
        code: inviteCode(),
        guildId,
        creatorId: userId,
        maxUses: input.maxUses,
        expiresAt: input.expiresInSeconds
          ? new Date(Date.now() + input.expiresInSeconds * 1000)
          : null,
      })
      .returning();
    if (!invite) throw new Error('invite insert returned nothing');
    return toInvite(invite);
  }

  async listInvites(userId: string, guildId: string): Promise<Invite[]> {
    requirePermission(requireActor(await this.load(guildId), userId), Permissions.ManageGuild);
    const rows = await this.db
      .select()
      .from(invites)
      .where(and(eq(invites.guildId, guildId), usable()))
      .orderBy(invites.createdAt);
    return rows.map(toInvite);
  }

  async deleteInvite(userId: string, code: string): Promise<void> {
    const [invite] = await this.db.select().from(invites).where(eq(invites.code, code));
    if (!invite) throw notFound('invite');
    const actor = requireActor(await this.load(invite.guildId), userId);
    if (invite.creatorId !== userId) requirePermission(actor, Permissions.ManageGuild);
    await this.db.delete(invites).where(eq(invites.code, code));
  }

  async previewInvite(userId: string, code: string): Promise<InvitePreview> {
    const [row] = await this.db
      .select({ invite: invites, guild: guilds })
      .from(invites)
      .innerJoin(guilds, eq(guilds.id, invites.guildId))
      .where(and(eq(invites.code, code), usable()));
    if (!row) throw inviteInvalid();
    const [members] = await this.db
      .select({ total: count() })
      .from(guildMembers)
      .where(eq(guildMembers.guildId, row.guild.id));
    const [membership] = await this.db
      .select({ userId: guildMembers.userId })
      .from(guildMembers)
      .where(and(eq(guildMembers.guildId, row.guild.id), eq(guildMembers.userId, userId)));
    return {
      code,
      guild: { id: row.guild.id, name: row.guild.name, memberCount: members?.total ?? 0 },
      alreadyMember: Boolean(membership),
    };
  }

  /** Joins the invite's guild. Uses are counted atomically so limits hold under races. */
  async acceptInvite(userId: string, code: string): Promise<Guild> {
    const [invite] = await this.db.select().from(invites).where(eq(invites.code, code));
    if (!invite) throw inviteInvalid();
    const guildId = invite.guildId;
    await this.refuseBanned(guildId, userId);

    const joined = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ userId: guildMembers.userId })
        .from(guildMembers)
        .where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, userId)));
      if (existing) return false;

      const [consumed] = await tx
        .update(invites)
        .set({ uses: sql`${invites.uses} + 1` })
        .where(and(eq(invites.code, code), usable()))
        .returning({ code: invites.code });
      if (!consumed) throw inviteInvalid();
      await tx.insert(guildMembers).values({ guildId, userId });
      return true;
    });

    if (joined) {
      const member = (await this.load(guildId)).members.get(userId);
      if (member)
        await this.bus.event(guildId, 'MEMBER_ADD', { guildId, member: toMember(member) });
      await this.bus.publish({ kind: 'guild-join', guildId, userId });
    }
    return this.get(userId, guildId);
  }

  // --- internals ----------------------------------------------------------------------------

  private async load(guildId: string, db: Queryable = this.db): Promise<GuildSnapshot> {
    const snapshot = await loadGuildSnapshot(db, guildId);
    if (!snapshot) throw notFound('guild');
    return snapshot;
  }

  private async refuseBanned(guildId: string, userId: string): Promise<void> {
    const [ban] = await this.db
      .select({ userId: guildBans.userId })
      .from(guildBans)
      .where(and(eq(guildBans.guildId, guildId), eq(guildBans.userId, userId)));
    if (ban) throw new AppError(403, ApiErrorCode.Banned, 'you are banned from this server');
  }

  private async loadChannel(channelId: string) {
    const [row] = await this.db
      .select({ guildId: channels.guildId })
      .from(channels)
      .where(eq(channels.id, channelId));
    if (!row) throw notFound('channel');
    const snapshot = await this.load(row.guildId);
    const channel = snapshot.channels.get(channelId);
    if (!channel) throw notFound('channel');
    return { snapshot, channel };
  }

  private async loadRole(roleId: string) {
    const [row] = await this.db
      .select({ guildId: roles.guildId })
      .from(roles)
      .where(eq(roles.id, roleId));
    if (!row) throw notFound('role');
    const snapshot = await this.load(row.guildId);
    const role = snapshot.roles.get(roleId);
    if (!role) throw notFound('role');
    return { snapshot, role };
  }

  private async channelPayload(guildId: string, channelId: string): Promise<Channel> {
    const snapshot = await this.load(guildId);
    const channel = snapshot.channels.get(channelId);
    if (!channel) throw notFound('channel');
    return toChannel(snapshot, channel);
  }

  /** Channels the user cannot see are reported as missing, not as forbidden. */
  private requireChannelPermission(
    snapshot: GuildSnapshot,
    userId: string,
    channelId: string,
    permission: bigint,
  ): Actor {
    const actor = requireActor(snapshot, userId);
    const permissions = channelPermissionsOf(snapshot, userId, channelId);
    if (!hasPermission(permissions, Permissions.ViewChannel)) throw notFound('channel');
    if (!hasPermission(permissions, permission)) throw forbidden();
    return actor;
  }

  /** Only categories can be parents, categories cannot be nested. */
  private validateParent(
    snapshot: GuildSnapshot,
    type: ChannelType,
    parentId: string | null,
  ): string | null {
    if (parentId === null) return null;
    if (type === 'category') throw badRequest('categories cannot be nested');
    if (snapshot.channels.get(parentId)?.type !== 'category') {
      throw badRequest('parent must be a category of the same server');
    }
    return parentId;
  }

  private async removeMember(guildId: string, userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(guildMembers)
        .where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, userId)));
      await tx
        .delete(channelOverwrites)
        .where(
          and(
            eq(channelOverwrites.targetId, userId),
            inArray(
              channelOverwrites.channelId,
              tx.select({ id: channels.id }).from(channels).where(eq(channels.guildId, guildId)),
            ),
          ),
        );
    });
    await this.bus.publish({ kind: 'guild-leave', guildId, userId });
    await this.bus.event(guildId, 'MEMBER_REMOVE', { guildId, userId });
    await this.deps.voice.enforce(guildId);
  }

  /** Roles or overwrites changed: resend the guild to everyone and re-check voice access. */
  private async permissionsChanged(guildId: string): Promise<void> {
    await this.bus.sync(guildId);
    await this.deps.voice.enforce(guildId);
  }
}

/** SQL condition for an invite that can still be used. */
function usable() {
  return and(
    or(isNull(invites.expiresAt), gt(invites.expiresAt, new Date())),
    or(isNull(invites.maxUses), lt(invites.uses, invites.maxUses)),
  );
}

function inviteInvalid(): AppError {
  return new AppError(404, 'invite_invalid', 'this invite is invalid or has expired');
}

function toInvite(row: typeof invites.$inferSelect): Invite {
  return {
    code: row.code,
    guildId: row.guildId,
    creatorId: row.creatorId,
    maxUses: row.maxUses,
    uses: row.uses,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
