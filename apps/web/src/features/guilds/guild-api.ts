import {
  banSchema,
  channelSchema,
  guildSchema,
  guildSoundSchema,
  guildSummarySchema,
  invitePreviewSchema,
  inviteSchema,
  memberSchema,
  roleSchema,
  voiceTokenResponseSchema,
  type CreateChannelRequest,
  type CreateInviteRequest,
  type GuildSoundEvent,
  type PutOverwriteRequest,
  type UpdateChannelRequest,
  type UpdateMemberRequest,
  type UpdateRoleRequest,
} from '@frequencia/shared';
import { z } from 'zod';
import { api, apiBlob } from '../../lib/http';

/** Thin, typed wrappers over the REST API. State changes come back through the gateway. */
export const guildApi = {
  create: (name: string) => api('POST', '/guilds', { body: { name }, schema: guildSchema }),
  rename: (guildId: string, name: string) =>
    api('PATCH', `/guilds/${guildId}`, { body: { name }, schema: guildSummarySchema }),
  /** The image goes as raw bytes; the server recognises the format by itself. */
  setIcon: (guildId: string, image: Blob) =>
    api('PUT', `/guilds/${guildId}/icon`, {
      body: new Blob([image], { type: 'application/octet-stream' }),
      schema: guildSummarySchema,
    }),
  clearIcon: (guildId: string) =>
    api('DELETE', `/guilds/${guildId}/icon`, { schema: guildSummarySchema }),
  delete: (guildId: string) => api('DELETE', `/guilds/${guildId}`),
  leave: (guildId: string) => api('DELETE', `/guilds/${guildId}/members/@me`),

  /** Owner only: the sound every member hears for an event. */
  setSound: (guildId: string, event: GuildSoundEvent, file: File) =>
    api('PUT', `/guilds/${guildId}/sounds/${event}?filename=${encodeURIComponent(file.name)}`, {
      // The server identifies the format from the bytes, whatever the browser calls it.
      body: new Blob([file], { type: 'application/octet-stream' }),
      schema: guildSoundSchema,
    }),
  clearSound: (guildId: string, event: GuildSoundEvent) =>
    api('DELETE', `/guilds/${guildId}/sounds/${event}`),
  soundBlob: (guildId: string, event: GuildSoundEvent) =>
    apiBlob(`/guilds/${guildId}/sounds/${event}`),

  kick: (guildId: string, userId: string) => api('DELETE', `/guilds/${guildId}/members/${userId}`),
  disconnectFromVoice: (guildId: string, userId: string) =>
    api('DELETE', `/guilds/${guildId}/voice-states/${userId}`),
  bans: (guildId: string) => api('GET', `/guilds/${guildId}/bans`, { schema: z.array(banSchema) }),
  ban: (guildId: string, userId: string) => api('PUT', `/guilds/${guildId}/bans/${userId}`),
  unban: (guildId: string, userId: string) => api('DELETE', `/guilds/${guildId}/bans/${userId}`),
  updateMember: (guildId: string, userId: string, body: UpdateMemberRequest) =>
    api('PATCH', `/guilds/${guildId}/members/${userId}`, { body, schema: memberSchema }),

  createChannel: (guildId: string, body: CreateChannelRequest) =>
    api('POST', `/guilds/${guildId}/channels`, { body, schema: channelSchema }),
  updateChannel: (channelId: string, body: UpdateChannelRequest) =>
    api('PATCH', `/channels/${channelId}`, { body, schema: channelSchema }),
  deleteChannel: (channelId: string) => api('DELETE', `/channels/${channelId}`),
  reorderChannels: (guildId: string, channels: Array<{ id: string; parentId: string | null }>) =>
    api('PUT', `/guilds/${guildId}/channels/order`, { body: { channels } }),
  createThread: (channelId: string, name: string) =>
    api('POST', `/channels/${channelId}/threads`, { body: { name }, schema: channelSchema }),
  putOverwrite: (channelId: string, targetId: string, body: PutOverwriteRequest) =>
    api('PUT', `/channels/${channelId}/overwrites/${targetId}`, { body, schema: channelSchema }),
  deleteOverwrite: (channelId: string, targetId: string) =>
    api('DELETE', `/channels/${channelId}/overwrites/${targetId}`, { schema: channelSchema }),

  createRole: (guildId: string, name: string) =>
    api('POST', `/guilds/${guildId}/roles`, { body: { name }, schema: roleSchema }),
  updateRole: (roleId: string, body: UpdateRoleRequest) =>
    api('PATCH', `/roles/${roleId}`, { body, schema: roleSchema }),
  deleteRole: (roleId: string) => api('DELETE', `/roles/${roleId}`),
  reorderRoles: (guildId: string, roleIds: string[]) =>
    api('PUT', `/guilds/${guildId}/roles/order`, {
      body: { roleIds },
      schema: z.array(roleSchema),
    }),

  createInvite: (guildId: string, body: CreateInviteRequest) =>
    api('POST', `/guilds/${guildId}/invites`, { body, schema: inviteSchema }),
  listInvites: (guildId: string) =>
    api('GET', `/guilds/${guildId}/invites`, { schema: z.array(inviteSchema) }),
  deleteInvite: (code: string) => api('DELETE', `/invites/${code}`),
  previewInvite: (code: string) => api('GET', `/invites/${code}`, { schema: invitePreviewSchema }),
  acceptInvite: (code: string) => api('POST', `/invites/${code}/accept`, { schema: guildSchema }),

  voiceToken: (channelId: string) =>
    api('POST', `/channels/${channelId}/voice-token`, { schema: voiceTokenResponseSchema }),
};

/** Pulls an invite code out of whatever the user pasted: a full link or the bare code. */
export function parseInviteCode(input: string): string {
  const trimmed = input.trim();
  const match = /\/invite\/([a-zA-Z0-9]+)/.exec(trimmed);
  return match?.[1] ?? trimmed;
}

export function inviteLink(code: string): string {
  return `${window.location.origin}/invite/${code}`;
}
