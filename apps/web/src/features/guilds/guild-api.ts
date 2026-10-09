import {
  channelSchema,
  guildSchema,
  guildSummarySchema,
  invitePreviewSchema,
  inviteSchema,
  memberSchema,
  roleSchema,
  voiceTokenResponseSchema,
  type CreateChannelRequest,
  type CreateInviteRequest,
  type PutOverwriteRequest,
  type UpdateChannelRequest,
  type UpdateMemberRequest,
  type UpdateRoleRequest,
} from '@frequencia/shared';
import { z } from 'zod';
import { api } from '../../lib/http';

/** Thin, typed wrappers over the REST API. State changes come back through the gateway. */
export const guildApi = {
  create: (name: string) => api('POST', '/guilds', { body: { name }, schema: guildSchema }),
  rename: (guildId: string, name: string) =>
    api('PATCH', `/guilds/${guildId}`, { body: { name }, schema: guildSummarySchema }),
  delete: (guildId: string) => api('DELETE', `/guilds/${guildId}`),
  leave: (guildId: string) => api('DELETE', `/guilds/${guildId}/members/@me`),

  kick: (guildId: string, userId: string) => api('DELETE', `/guilds/${guildId}/members/${userId}`),
  updateMember: (guildId: string, userId: string, body: UpdateMemberRequest) =>
    api('PATCH', `/guilds/${guildId}/members/${userId}`, { body, schema: memberSchema }),

  createChannel: (guildId: string, body: CreateChannelRequest) =>
    api('POST', `/guilds/${guildId}/channels`, { body, schema: channelSchema }),
  updateChannel: (channelId: string, body: UpdateChannelRequest) =>
    api('PATCH', `/channels/${channelId}`, { body, schema: channelSchema }),
  deleteChannel: (channelId: string) => api('DELETE', `/channels/${channelId}`),
  reorderChannels: (guildId: string, channels: Array<{ id: string; parentId: string | null }>) =>
    api('PUT', `/guilds/${guildId}/channels/order`, { body: { channels } }),
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
