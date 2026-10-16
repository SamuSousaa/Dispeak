import { canMention, requestMention } from '../chat/mention-bus';
import {
  hasPermission,
  outranks,
  Permissions,
  type FriendRequest,
  type Guild,
} from '@frequencia/shared';
import type { MouseEvent } from 'react';
import {
  contextMenu,
  isContextMenuOpen,
  openContextMenu,
  type MenuEntry,
} from '../../components/ContextMenu';
import { showLink } from '../../components/LinkDialog';
import { attempt, toast } from '../../components/Toast';
import { ApiError } from '../../lib/http';
import { queryClient } from '../../lib/query-client';
import { conversationsApi, useBlockStore } from '../friends/conversations-api';
import { conversationWith } from '../friends/dm';
import { FRIEND_REQUESTS_KEY, friendsApi } from '../friends/friends-api';
import { openConversation } from '../friends/open-conversation';
import { ProfileActions } from '../profile/ProfileActions';
import { ProfileCard } from '../profile/ProfileCard';
import { volumeMenuEntries } from '../voice/components/VolumeControl';
import { unwatchStream, watchStream } from '../voice/voice-actions';
import { isLive, useVoiceStore } from '../voice/voice-store';
import { guildApi } from './guild-api';
import { actorIn, memberColor, memberName } from './permissions';

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
 * The entry that makes a friend of someone met in a server, or `false` when they already are
 * one, or when one of the two blocks the other.
 */
function friendEntry(
  selfId: string,
  targetId: string,
  username: string,
  name: string,
): MenuEntry | false {
  const conversation = conversationWith(selfId, targetId);
  if (conversation?.state.friend || conversation?.state.blocked) return false;
  if (useBlockStore.getState().includes(targetId)) return false;
  // Loaded with the app and kept current by the gateway; without it the server still decides.
  const pending = queryClient
    .getQueryData<FriendRequest[]>(FRIEND_REQUESTS_KEY)
    ?.find((request) => request.user.id === targetId);
  if (pending?.direction === 'outgoing') {
    return {
      label: 'Adicionar amigo',
      hint: 'PEDIDO ENVIADO',
      disabled: true,
      onSelect: () => undefined,
    };
  }
  if (pending) {
    return {
      label: 'Aceitar pedido de amizade',
      onSelect: () =>
        attempt(async () => {
          await friendsApi.accept(pending.id);
          toast(`Você e ${name} agora são amigos.`, 'info');
        }),
    };
  }
  return {
    label: 'Adicionar amigo',
    onSelect: () =>
      void friendsApi.ask(username).then(
        // The other person had already asked: the two requests met.
        ({ guild }) =>
          toast(
            guild ? `Você e ${name} agora são amigos.` : `Pedido de amizade enviado para ${name}.`,
            'info',
          ),
        (error: unknown) =>
          error instanceof ApiError && error.status === 409
            ? toast(`Você já enviou um pedido para ${name}.`, 'info')
            : attempt(() => Promise.reject(error)),
      ),
  };
}

/**
 * The card a person made for themselves: what a plain click on their name shows. Under it, a
 * box to write to them, which opens the conversation.
 */
export function openUserProfile(
  { guild, targetId, selfId }: Pick<UserMenuContext, 'guild' | 'targetId' | 'selfId'>,
  point: { x: number; y: number },
): void {
  const member = guild.members.find((entry) => entry.user.id === targetId);
  if (!member) return;
  const name = memberName(guild, targetId);
  const online = guild.onlineUserIds.includes(targetId);
  const roles = guild.roles
    .filter((role) => role.id !== guild.id && member.roleIds.includes(role.id))
    .sort((a, b) => b.position - a.position);

  openContextMenu(
    point,
    name,
    [
      {
        type: 'custom',
        key: 'profile',
        render: (close) => (
          // Edge to edge inside the menu, which pads its custom entries.
          <div className="-mx-3 -my-2">
            <ProfileCard
              user={member.user}
              name={name}
              presence={online ? member.user.status : 'offline'}
              nameColor={memberColor(guild, targetId)}
              roles={roles}
              memberSince={member.joinedAt}
              isOwner={guild.ownerId === targetId}
              activity={guild.activities[targetId]}
            />
            {targetId !== selfId && (
              <ProfileActions
                selfId={selfId}
                userId={targetId}
                username={member.user.username}
                onDone={close}
              />
            )}
          </div>
        ),
      },
    ],
    { wide: true },
  );
}

/**
 * Everything one can do about a person, the same wherever their name shows up. What belongs to
 * a call (how loud they are for this user, server mute, disconnect) is only there while the
 * person is in one; the server-wide actions are always there for those allowed to moderate.
 * The server checks every one of them again.
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
  // The person's stream, when they share in the call this user is in.
  const voice = useVoiceStore.getState();
  const peer = isSelf
    ? undefined
    : Object.values(voice.peers).find((entry) => entry.userId === targetId && isLive(entry));
  const watching = peer ? Boolean(voice.watching[peer.id]) : false;
  const streamHasAudio = peer?.producers.some((producer) => producer.source === 'screen-audio');

  return [
    { label: 'Perfil', onSelect: () => openUserProfile({ guild, targetId, selfId }, point) },
    // Only while a message is being written in the channel on screen.
    !isSelf && canMention() && { label: 'Mencionar', onSelect: () => requestMention(name) },
    !isSelf && {
      label: 'Mensagem',
      onSelect: () => attempt(() => openConversation(targetId)),
    },
    !isSelf && friendEntry(selfId, targetId, member.user.username, name),
    { type: 'separator' },
    ...(inVoice && !isSelf ? volumeMenuEntries(targetId, name) : []),
    { type: 'separator' },
    peer &&
      (watching
        ? { label: 'Parar de assistir', onSelect: () => unwatchStream(peer.id) }
        : { label: 'Assistir transmissão', onSelect: () => watchStream(peer.id) }),
    ...(peer && watching && streamHasAudio ? volumeMenuEntries(targetId, name, 'stream') : []),
    { type: 'separator' },
    // Someone muted who has left the call can still be given the microphone back.
    (inVoice || member.serverMuted) &&
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
    !isSelf &&
      actor.isOwner && {
        label: 'Link de nova senha',
        onSelect: () =>
          attempt(async () => {
            const { token } = await guildApi.passwordReset(guild.id, targetId);
            showLink(
              `Nova senha para ${name}`,
              `Mande este link para ${name}. Ele abre uma página para escolher uma senha nova, funciona uma vez só e vale por uma hora.`,
              `${window.location.origin}/reset/${token}`,
            );
          }),
      },
    { type: 'separator' },
    !isSelf &&
      (useBlockStore.getState().includes(targetId)
        ? {
            label: 'Desbloquear',
            onSelect: () => attempt(() => conversationsApi.unblock(targetId)),
          }
        : {
            label: 'Bloquear',
            danger: true,
            onSelect: () =>
              confirm(point, `BLOQUEAR ${name}?`, 'Sim, bloquear', async () => {
                await conversationsApi.block(targetId);
                toast(`Você bloqueou ${name}. As mensagens dele ficam escondidas.`, 'info');
              }),
          }),
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

/** Props that open a person's menu of actions on right click and long press. */
export function userContextMenu(context: UserMenuContext) {
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
  };
}

/**
 * Props for a person's name in a list: a click shows their profile, a right click or a long
 * press opens the menu of actions.
 */
export function userMenu(context: UserMenuContext) {
  return {
    ...userContextMenu(context),
    onClick: (event: MouseEvent) => {
      // Buttons inside (such as "watch") keep their own click.
      const control = (event.target as HTMLElement).closest('button, a');
      if (control && control !== event.currentTarget) return;
      // A long press has just opened the menu of actions; lifting the finger is not a click.
      if (isContextMenuOpen()) return;
      openUserProfile(context, { x: event.clientX, y: event.clientY });
    },
  };
}
