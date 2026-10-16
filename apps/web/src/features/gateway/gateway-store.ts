import type { GatewayEventData, GatewayEventName, Guild } from '@frequencia/shared';
import { create } from 'zustand';

export type GatewayStatus = 'idle' | 'connecting' | 'ready' | 'reconnecting';

export interface GatewayState {
  status: GatewayStatus;
  /** Guilds the user belongs to, keyed by id. Kept in sync by gateway events. */
  guilds: Record<string, Guild>;
  /** Guild ids in the order the user joined them. */
  guildOrder: string[];
}

export const initialGatewayState: GatewayState = { status: 'idle', guilds: {}, guildOrder: [] };

export const useGatewayStore = create<GatewayState>(() => initialGatewayState);

type Reducer<T extends GatewayEventName> = (
  state: GatewayState,
  data: GatewayEventData<T>,
) => Partial<GatewayState>;

function updateGuild(
  state: GatewayState,
  guildId: string,
  update: (guild: Guild) => Guild,
): Partial<GatewayState> {
  const guild = state.guilds[guildId];
  return guild ? { guilds: { ...state.guilds, [guildId]: update(guild) } } : {};
}

const upsertGuild = (state: GatewayState, guild: Guild): Partial<GatewayState> => ({
  guilds: { ...state.guilds, [guild.id]: guild },
  guildOrder: state.guildOrder.includes(guild.id)
    ? state.guildOrder
    : [...state.guildOrder, guild.id],
});

const byPosition = (a: { position: number; id: string }, b: { position: number; id: string }) =>
  a.position - b.position || a.id.localeCompare(b.id);

/** How each dispatch changes the local copy of the guilds. Pure, so it is easy to test. */
export const gatewayReducers: { [T in GatewayEventName]: Reducer<T> } = {
  READY: (_state, data) => ({
    status: 'ready',
    guilds: Object.fromEntries(data.guilds.map((guild) => [guild.id, guild])),
    guildOrder: data.guilds.map((guild) => guild.id),
  }),
  RESUMED: () => ({ status: 'ready' }),

  GUILD_CREATE: upsertGuild,
  GUILD_SYNC: upsertGuild,
  GUILD_UPDATE: (state, data) =>
    updateGuild(state, data.id, (guild) => ({ ...guild, name: data.name, icon: data.icon })),
  GUILD_DELETE: (state, data) => {
    const { [data.id]: _removed, ...guilds } = state.guilds;
    return { guilds, guildOrder: state.guildOrder.filter((id) => id !== data.id) };
  },

  CHANNEL_CREATE: (state, channel) =>
    updateGuild(state, channel.guildId, (guild) => ({
      ...guild,
      channels: [...guild.channels.filter((entry) => entry.id !== channel.id), channel].sort(
        byPosition,
      ),
    })),
  CHANNEL_UPDATE: (state, channel) =>
    updateGuild(state, channel.guildId, (guild) => ({
      ...guild,
      channels: guild.channels
        .map((entry) => (entry.id === channel.id ? channel : entry))
        .sort(byPosition),
    })),
  CHANNEL_DELETE: (state, data) =>
    updateGuild(state, data.guildId, (guild) => ({
      ...guild,
      channels: guild.channels
        .filter((channel) => channel.id !== data.id)
        .map((channel) =>
          channel.parentId === data.id ? { ...channel, parentId: null } : channel,
        ),
      voiceStates: guild.voiceStates.filter((voice) => voice.channelId !== data.id),
    })),

  MEMBER_ADD: (state, data) =>
    updateGuild(state, data.guildId, (guild) => ({
      ...guild,
      members: [
        ...guild.members.filter((member) => member.user.id !== data.member.user.id),
        data.member,
      ],
    })),
  MEMBER_UPDATE: (state, data) =>
    updateGuild(state, data.guildId, (guild) => ({
      ...guild,
      members: guild.members.map((member) =>
        member.user.id === data.member.user.id ? data.member : member,
      ),
    })),
  MEMBER_REMOVE: (state, data) =>
    updateGuild(state, data.guildId, (guild) => ({
      ...guild,
      members: guild.members.filter((member) => member.user.id !== data.userId),
      onlineUserIds: guild.onlineUserIds.filter((id) => id !== data.userId),
      voiceStates: guild.voiceStates.filter((voice) => voice.userId !== data.userId),
    })),

  PRESENCE_UPDATE: (state, data) => ({
    guilds: Object.fromEntries(
      Object.entries(state.guilds).map(([id, guild]) => {
        if (!guild.members.some((member) => member.user.id === data.userId)) return [id, guild];
        const others = guild.onlineUserIds.filter((userId) => userId !== data.userId);
        return [
          id,
          { ...guild, onlineUserIds: data.status === 'online' ? [...others, data.userId] : others },
        ];
      }),
    ),
  }),

  ACTIVITY_UPDATE: (state, data) => ({
    guilds: Object.fromEntries(
      Object.entries(state.guilds).map(([id, guild]) => {
        if (!guild.members.some((member) => member.user.id === data.userId)) return [id, guild];
        const { [data.userId]: _previous, ...others } = guild.activities;
        return [
          id,
          {
            ...guild,
            activities: data.activity ? { ...others, [data.userId]: data.activity } : others,
          },
        ];
      }),
    ),
  }),

  VOICE_STATE_UPDATE: (state, data) =>
    updateGuild(state, data.guildId, (guild) => {
      const others = guild.voiceStates.filter((voice) => voice.userId !== data.userId);
      if (data.channelId === null) return { ...guild, voiceStates: others };
      return {
        ...guild,
        voiceStates: [
          ...others,
          {
            guildId: data.guildId,
            channelId: data.channelId,
            userId: data.userId,
            muted: data.muted,
            deafened: data.deafened,
            streaming: data.streaming,
          },
        ],
      };
    }),

  // Chat events do not touch guild state; the chat feature keeps its own caches.
  MESSAGE_CREATE: () => ({}),
  MESSAGE_UPDATE: () => ({}),
  MESSAGE_DELETE: () => ({}),
  TYPING_START: () => ({}),
  // Pending friend requests are server state, kept in the query cache.
  FRIEND_REQUEST_CREATE: () => ({}),
  FRIEND_REQUEST_DELETE: () => ({}),
  // The account's preferences have their own store (`settings/account-settings`).
  USER_SETTINGS_UPDATE: () => ({}),
  // Blocked people live in `friends/conversations-api`.
  BLOCKS_UPDATE: () => ({}),
};

export function applyGatewayEvent<T extends GatewayEventName>(
  t: T,
  data: GatewayEventData<T>,
): void {
  useGatewayStore.setState((state) => gatewayReducers[t](state, data));
}
