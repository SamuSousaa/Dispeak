import { hasPermission, outranks, Permissions, type Guild } from '@frequencia/shared';
import type { MouseEvent } from 'react';
import { contextMenu, openContextMenu, type MenuEntry } from '../../components/ContextMenu';
import { attempt } from '../../components/Toast';
import { volumeMenuEntries } from '../voice/components/VolumeControl';
import { guildApi } from './guild-api';
import { actorIn, memberName } from './permissions';

export interface UserMenuContext {
  guild: Guild;
  /** Whose menu it is. */
  targetId: string;
  /** Who is looking. */
  selfId: string;
  /** Opens the server settings on the member list (roles, nickname). */
  onManageMembers?: () => void;
}

type Entries = Array<MenuEntry | false | null | undefined>;

/** A destructive choice is confirmed in a second menu, opened where the first one was. */
function confirm(
  point: { x: number; y: number },
  question: string,
  label: string,
  action: () => Promise<unknown>,
): void {
  openContextMenu(point, question, [
    { label, danger: true, onSelect: () => attempt(action) },
    { label: 'Cancelar', onSelect: () => undefined },
  ]);
}

/**
 * Everything one can do about a person, the same wherever their name shows up: how loud they
 * are for this user, and, for those allowed to moderate, the server-wide actions. The server
 * checks every one of them again.
 */
export function userMenuEntries(
  { guild, targetId, selfId, onManageMembers }: UserMenuContext,
  point: { x: number; y: number },
): Entries {
  const member = guild.members.find((entry) => entry.user.id === targetId);
  if (!member) return [];
  const name = memberName(guild, targetId);
  const isSelf = targetId === selfId;
  const actor = actorIn(guild, selfId);
  const target = actorIn(guild, targetId);
  const can = (permission: bigint) => hasPermission(actor.permissions, permission);
  const above = outranks(actor, target);
  const inVoice = guild.voiceStates.some((state) => state.userId === targetId);

  return [
    ...(isSelf ? [] : volumeMenuEntries(targetId, name)),
    { type: 'separator' },
    can(Permissions.MuteMembers) &&
      (isSelf || above) && {
        label: member.serverMuted ? 'Devolver o microfone' : 'Mutar no servidor',
        hint: member.serverMuted ? 'MUTADO' : undefined,
        onSelect: () =>
          attempt(() =>
            guildApi.updateMember(guild.id, targetId, { serverMuted: !member.serverMuted }),
          ),
      },
    inVoice &&
      can(Permissions.DisconnectMembers) &&
      (isSelf || above) && {
        label: 'Desconectar da chamada',
        onSelect: () => attempt(() => guildApi.disconnectFromVoice(guild.id, targetId)),
      },
    { type: 'separator' },
    {
      label: 'Copiar nome de usuário',
      hint: `@${member.user.username}`,
      onSelect: () => void navigator.clipboard?.writeText(member.user.username),
    },
    onManageMembers &&
      (can(Permissions.ManageRoles) || can(Permissions.KickMembers)) && {
        label: 'Cargos e membros',
        onSelect: onManageMembers,
      },
    { type: 'separator' },
    !isSelf &&
      above &&
      can(Permissions.KickMembers) && {
        label: 'Expulsar do servidor',
        danger: true,
        onSelect: () =>
          confirm(point, `EXPULSAR ${name}?`, 'Sim, expulsar', () =>
            guildApi.kick(guild.id, targetId),
          ),
      },
    !isSelf &&
      above &&
      can(Permissions.BanMembers) && {
        label: 'Banir do servidor',
        danger: true,
        onSelect: () =>
          confirm(point, `BANIR ${name}?`, 'Sim, banir', () => guildApi.ban(guild.id, targetId)),
      },
  ];
}

/**
 * Props that open a person's menu on click, right click and long press, so it is found
 * whatever the habit.
 */
export function userMenu(context: UserMenuContext) {
  const title = memberName(context.guild, context.targetId);
  // The long press has no pointer position to hand over; the menu itself reads it from the store.
  let last = { x: 0, y: 0 };
  const handlers = contextMenu(title, () => userMenuEntries(context, last));
  return {
    ...handlers,
    onContextMenu: (event: MouseEvent) => {
      last = { x: event.clientX, y: event.clientY };
      handlers.onContextMenu(event);
    },
    onTouchStart: (event: Parameters<typeof handlers.onTouchStart>[0]) => {
      const touch = event.touches[0];
      if (touch) last = { x: touch.clientX, y: touch.clientY };
      handlers.onTouchStart(event);
    },
    onClick: (event: MouseEvent) => {
      // Buttons inside (such as "watch") keep their own click.
      const control = (event.target as HTMLElement).closest('button, a');
      if (control && control !== event.currentTarget) return;
      last = { x: event.clientX, y: event.clientY };
      openContextMenu(last, title, userMenuEntries(context, last));
    },
  };
}
