import {
  GUILD_SOUND_MAX_BYTES,
  banSchema,
  PICTURE_MAX_BYTES,
  channelSchema,
  createChannelRequestSchema,
  createGuildRequestSchema,
  createInviteRequestSchema,
  createRoleRequestSchema,
  createThreadRequestSchema,
  guildSchema,
  guildSoundEventSchema,
  guildSoundSchema,
  guildSummarySchema,
  idSchema,
  invitePreviewSchema,
  inviteSchema,
  memberSchema,
  putOverwriteRequestSchema,
  reorderChannelsRequestSchema,
  reorderRolesRequestSchema,
  roleSchema,
  updateChannelRequestSchema,
  updateGuildRequestSchema,
  updateMemberRequestSchema,
  updateRoleRequestSchema,
  uploadGuildSoundQuerySchema,
} from '@frequencia/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { badRequest } from '../../errors';

const guildParams = z.object({ guildId: idSchema });
const memberParams = guildParams.extend({ userId: idSchema });
const soundParams = guildParams.extend({ event: guildSoundEventSchema });
const channelParams = z.object({ channelId: idSchema });
const overwriteParams = channelParams.extend({ targetId: idSchema });
const roleParams = z.object({ roleId: idSchema });
const inviteParams = z.object({ code: z.string().min(4).max(32) });
const noContent = { 204: z.null() };

export const guildRoutes: FastifyPluginAsyncZod = async (app) => {
  const { guilds } = app.ctx;
  const security = [{ bearerAuth: [] }];
  app.addHook('onRequest', app.authenticate);

  // --- guilds -------------------------------------------------------------------------------

  app.get(
    '/guilds',
    {
      schema: {
        tags: ['guilds'],
        summary: 'Guilds the user belongs to',
        security,
        response: { 200: z.array(guildSummarySchema) },
      },
    },
    (request) => guilds.list(request.auth.userId),
  );

  app.post(
    '/guilds',
    {
      schema: {
        tags: ['guilds'],
        summary: 'Create a guild with default channels',
        security,
        body: createGuildRequestSchema,
        response: { 201: guildSchema },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await guilds.create(request.auth.userId, request.body.name)),
  );

  app.get(
    '/guilds/:guildId',
    {
      schema: {
        tags: ['guilds'],
        summary: 'A guild as the user sees it (only viewable channels)',
        security,
        params: guildParams,
        response: { 200: guildSchema },
      },
    },
    (request) => guilds.get(request.auth.userId, request.params.guildId),
  );

  app.patch(
    '/guilds/:guildId',
    {
      schema: {
        tags: ['guilds'],
        summary: 'Rename a guild (MANAGE_GUILD)',
        security,
        params: guildParams,
        body: updateGuildRequestSchema,
        response: { 200: guildSummarySchema },
      },
    },
    (request) => guilds.rename(request.auth.userId, request.params.guildId, request.body.name),
  );

  app.delete(
    '/guilds/:guildId',
    {
      schema: {
        tags: ['guilds'],
        summary: 'Delete a guild (owner only)',
        security,
        params: guildParams,
        response: noContent,
      },
    },
    async (request, reply) => {
      await guilds.delete(request.auth.userId, request.params.guildId);
      return reply.code(204).send(null);
    },
  );

  // --- notification sounds ------------------------------------------------------------------

  // Sound uploads arrive as raw bytes; this parser exists only inside this plugin.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: GUILD_SOUND_MAX_BYTES },
    (_request, body, done) => done(null, body),
  );

  app.delete(
    '/guilds/:guildId/voice-states/:userId',
    {
      schema: {
        tags: ['guilds'],
        summary: 'Take a member out of the voice channel they are in (DISCONNECT_MEMBERS)',
        security,
        params: memberParams,
        response: noContent,
      },
    },
    async (request, reply) => {
      await guilds.disconnectFromVoice(
        request.auth.userId,
        request.params.guildId,
        request.params.userId,
      );
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/guilds/:guildId/bans',
    {
      schema: {
        tags: ['guilds'],
        summary: 'People banned from the server (BAN_MEMBERS)',
        security,
        params: guildParams,
        response: { 200: z.array(banSchema) },
      },
    },
    (request) => guilds.listBans(request.auth.userId, request.params.guildId),
  );

  app.put(
    '/guilds/:guildId/bans/:userId',
    {
      schema: {
        tags: ['guilds'],
        summary: 'Ban someone: removes them and refuses their invites (BAN_MEMBERS)',
        security,
        params: memberParams,
        response: noContent,
      },
    },
    async (request, reply) => {
      await guilds.ban(request.auth.userId, request.params.guildId, request.params.userId);
      return reply.code(204).send(null);
    },
  );

  app.delete(
    '/guilds/:guildId/bans/:userId',
    {
      schema: {
        tags: ['guilds'],
        summary: 'Lift a ban (BAN_MEMBERS)',
        security,
        params: memberParams,
        response: noContent,
      },
    },
    async (request, reply) => {
      await guilds.unban(request.auth.userId, request.params.guildId, request.params.userId);
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/channels/:channelId/threads',
    {
      schema: {
        tags: ['guilds'],
        summary: 'Open a thread under a text channel (SEND_MESSAGES)',
        description:
          'A thread is a side conversation with the permissions of the channel it hangs from. ' +
          'It is deleted with that channel.',
        security,
        params: channelParams,
        body: createThreadRequestSchema,
        response: { 201: channelSchema },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await guilds.createThread(
            request.auth.userId,
            request.params.channelId,
            request.body.name,
          ),
        ),
  );

  app.put(
    '/guilds/:guildId/icon',
    {
      bodyLimit: PICTURE_MAX_BYTES,
      schema: {
        tags: ['guilds'],
        summary: 'Set the server icon (MANAGE_GUILD)',
        description:
          'The body is the raw image (PNG, JPEG, GIF or WebP, up to 1 MiB) sent as ' +
          '`application/octet-stream`. It is served at `/images/:id`.',
        security,
        consumes: ['application/octet-stream'],
        params: guildParams,
        response: { 200: guildSummarySchema },
      },
    },
    (request) => {
      if (!Buffer.isBuffer(request.body)) throw badRequest('the body must be an image');
      return guilds.setIcon(request.auth.userId, request.params.guildId, request.body);
    },
  );

  app.delete(
    '/guilds/:guildId/icon',
    {
      schema: {
        tags: ['guilds'],
        summary: 'Remove the server icon (MANAGE_GUILD)',
        security,
        params: guildParams,
        response: { 200: guildSummarySchema },
      },
    },
    (request) => guilds.setIcon(request.auth.userId, request.params.guildId, null),
  );

  app.put(
    '/guilds/:guildId/sounds/:event',
    {
      bodyLimit: GUILD_SOUND_MAX_BYTES,
      schema: {
        tags: ['guilds'],
        summary: 'Set the sound every member hears for an event (owner only)',
        description:
          'The body is the raw audio file (MP3, WAV, Ogg, FLAC, M4A or WebM, up to 2 MiB) sent ' +
          'as `application/octet-stream`. The type is verified from the bytes.',
        security,
        consumes: ['application/octet-stream'],
        params: soundParams,
        querystring: uploadGuildSoundQuerySchema,
        response: { 200: guildSoundSchema },
      },
    },
    (request) => {
      if (!Buffer.isBuffer(request.body)) throw badRequest('the body must be an audio file');
      return guilds.setSound(
        request.auth.userId,
        request.params.guildId,
        request.params.event,
        request.query.filename,
        request.body,
      );
    },
  );

  app.delete(
    '/guilds/:guildId/sounds/:event',
    {
      schema: {
        tags: ['guilds'],
        summary: 'Go back to the built-in sound for an event (owner only)',
        security,
        params: soundParams,
        response: noContent,
      },
    },
    async (request, reply) => {
      await guilds.clearSound(request.auth.userId, request.params.guildId, request.params.event);
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/guilds/:guildId/sounds/:event',
    {
      schema: {
        tags: ['guilds'],
        summary: 'Download the custom sound of an event (members only)',
        security,
        params: soundParams,
      },
    },
    async (request, reply) => {
      const sound = await guilds.sound(
        request.auth.userId,
        request.params.guildId,
        request.params.event,
      );
      return (
        reply
          .header('content-type', sound.contentType)
          .header('content-length', sound.size)
          // The file behind this address changes when the owner picks another one.
          .header('cache-control', 'private, no-cache')
          .header('x-content-type-options', 'nosniff')
          .header('content-security-policy', "default-src 'none'; sandbox")
          .send(sound.stream)
      );
    },
  );

  // --- members ------------------------------------------------------------------------------

  app.delete(
    '/guilds/:guildId/members/@me',
    {
      schema: {
        tags: ['members'],
        summary: 'Leave a guild',
        security,
        params: guildParams,
        response: noContent,
      },
    },
    async (request, reply) => {
      await guilds.leave(request.auth.userId, request.params.guildId);
      return reply.code(204).send(null);
    },
  );

  app.delete(
    '/guilds/:guildId/members/:userId',
    {
      schema: {
        tags: ['members'],
        summary: 'Kick a member with a lower role (KICK_MEMBERS)',
        security,
        params: memberParams,
        response: noContent,
      },
    },
    async (request, reply) => {
      await guilds.kick(request.auth.userId, request.params.guildId, request.params.userId);
      return reply.code(204).send(null);
    },
  );

  app.patch(
    '/guilds/:guildId/members/:userId',
    {
      schema: {
        tags: ['members'],
        summary: 'Set the roles (MANAGE_ROLES) or nickname of a member',
        security,
        params: memberParams,
        body: updateMemberRequestSchema,
        response: { 200: memberSchema },
      },
    },
    (request) =>
      guilds.updateMember(
        request.auth.userId,
        request.params.guildId,
        request.params.userId,
        request.body,
      ),
  );

  // --- channels -----------------------------------------------------------------------------

  app.post(
    '/guilds/:guildId/channels',
    {
      schema: {
        tags: ['channels'],
        summary: 'Create a text channel, voice channel or category (MANAGE_CHANNELS)',
        security,
        params: guildParams,
        body: createChannelRequestSchema,
        response: { 201: channelSchema },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await guilds.createChannel(request.auth.userId, request.params.guildId, request.body),
        ),
  );

  app.put(
    '/guilds/:guildId/channels/order',
    {
      schema: {
        tags: ['channels'],
        summary: 'Reorder channels and move them between categories (MANAGE_CHANNELS)',
        security,
        params: guildParams,
        body: reorderChannelsRequestSchema,
        response: noContent,
      },
    },
    async (request, reply) => {
      await guilds.reorderChannels(
        request.auth.userId,
        request.params.guildId,
        request.body.channels,
      );
      return reply.code(204).send(null);
    },
  );

  app.patch(
    '/channels/:channelId',
    {
      schema: {
        tags: ['channels'],
        summary: 'Edit a channel (MANAGE_CHANNELS)',
        security,
        params: channelParams,
        body: updateChannelRequestSchema,
        response: { 200: channelSchema },
      },
    },
    (request) => guilds.updateChannel(request.auth.userId, request.params.channelId, request.body),
  );

  app.delete(
    '/channels/:channelId',
    {
      schema: {
        tags: ['channels'],
        summary: 'Delete a channel (MANAGE_CHANNELS)',
        security,
        params: channelParams,
        response: noContent,
      },
    },
    async (request, reply) => {
      await guilds.deleteChannel(request.auth.userId, request.params.channelId);
      return reply.code(204).send(null);
    },
  );

  app.put(
    '/channels/:channelId/overwrites/:targetId',
    {
      schema: {
        tags: ['channels'],
        summary: 'Set the permission overwrite of a role or member in a channel (MANAGE_ROLES)',
        security,
        params: overwriteParams,
        body: putOverwriteRequestSchema,
        response: { 200: channelSchema },
      },
    },
    (request) =>
      guilds.putOverwrite(
        request.auth.userId,
        request.params.channelId,
        request.params.targetId,
        request.body,
      ),
  );

  app.delete(
    '/channels/:channelId/overwrites/:targetId',
    {
      schema: {
        tags: ['channels'],
        summary: 'Remove a permission overwrite (MANAGE_ROLES)',
        security,
        params: overwriteParams,
        response: { 200: channelSchema },
      },
    },
    (request) =>
      guilds.deleteOverwrite(
        request.auth.userId,
        request.params.channelId,
        request.params.targetId,
      ),
  );

  // --- roles --------------------------------------------------------------------------------

  app.post(
    '/guilds/:guildId/roles',
    {
      schema: {
        tags: ['roles'],
        summary: 'Create a role at the bottom of the hierarchy (MANAGE_ROLES)',
        security,
        params: guildParams,
        body: createRoleRequestSchema,
        response: { 201: roleSchema },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(await guilds.createRole(request.auth.userId, request.params.guildId, request.body)),
  );

  app.put(
    '/guilds/:guildId/roles/order',
    {
      schema: {
        tags: ['roles'],
        summary: 'Set the role hierarchy, highest first (MANAGE_ROLES)',
        security,
        params: guildParams,
        body: reorderRolesRequestSchema,
        response: { 200: z.array(roleSchema) },
      },
    },
    (request) =>
      guilds.reorderRoles(request.auth.userId, request.params.guildId, request.body.roleIds),
  );

  app.patch(
    '/roles/:roleId',
    {
      schema: {
        tags: ['roles'],
        summary: 'Edit a role below your own (MANAGE_ROLES)',
        security,
        params: roleParams,
        body: updateRoleRequestSchema,
        response: { 200: roleSchema },
      },
    },
    (request) => guilds.updateRole(request.auth.userId, request.params.roleId, request.body),
  );

  app.delete(
    '/roles/:roleId',
    {
      schema: {
        tags: ['roles'],
        summary: 'Delete a role below your own (MANAGE_ROLES)',
        security,
        params: roleParams,
        response: noContent,
      },
    },
    async (request, reply) => {
      await guilds.deleteRole(request.auth.userId, request.params.roleId);
      return reply.code(204).send(null);
    },
  );

  // --- invites ------------------------------------------------------------------------------

  app.post(
    '/guilds/:guildId/invites',
    {
      schema: {
        tags: ['invites'],
        summary: 'Create an invite, optionally limited in uses and time (CREATE_INVITE)',
        security,
        params: guildParams,
        body: createInviteRequestSchema,
        response: { 201: inviteSchema },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(await guilds.createInvite(request.auth.userId, request.params.guildId, request.body)),
  );

  app.get(
    '/guilds/:guildId/invites',
    {
      schema: {
        tags: ['invites'],
        summary: 'Usable invites of a guild (MANAGE_GUILD)',
        security,
        params: guildParams,
        response: { 200: z.array(inviteSchema) },
      },
    },
    (request) => guilds.listInvites(request.auth.userId, request.params.guildId),
  );

  app.get(
    '/invites/:code',
    {
      schema: {
        tags: ['invites'],
        summary: 'Preview the guild an invite leads to',
        security,
        params: inviteParams,
        response: { 200: invitePreviewSchema },
      },
    },
    (request) => guilds.previewInvite(request.auth.userId, request.params.code),
  );

  app.post(
    '/invites/:code/accept',
    {
      schema: {
        tags: ['invites'],
        summary: 'Join a guild through an invite',
        security,
        params: inviteParams,
        response: { 200: guildSchema },
      },
    },
    (request) => guilds.acceptInvite(request.auth.userId, request.params.code),
  );

  app.delete(
    '/invites/:code',
    {
      schema: {
        tags: ['invites'],
        summary: 'Revoke an invite (its creator, or MANAGE_GUILD)',
        security,
        params: inviteParams,
        response: noContent,
      },
    },
    async (request, reply) => {
      await guilds.deleteInvite(request.auth.userId, request.params.code);
      return reply.code(204).send(null);
    },
  );
};
