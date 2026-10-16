import type {
  Activity,
  GatewayEventInput,
  GatewayEventName,
  PresenceStatus,
} from '@frequencia/shared';
import type { Redis } from '../redis';

const CHANNEL = 'frequencia:gateway';

/**
 * Messages exchanged between API instances over Redis pub/sub. Whoever handles a REST
 * request publishes; every instance (the publisher included) delivers to its own sockets.
 */
export type BusMessage =
  /**
   * An event for the members of a guild. `channelId` limits it to who can view that channel;
   * `userIds` names the audience outright, for when the channel no longer exists to ask.
   */
  | {
      kind: 'event';
      guildId: string;
      channelId?: string;
      userIds?: string[];
      t: GatewayEventName;
      d: unknown;
    }
  /** An event for every session of one user. */
  | { kind: 'user-event'; userId: string; t: GatewayEventName; d: unknown }
  /** Permissions or structure changed: resend the guild to each member as they now see it. */
  | { kind: 'guild-sync'; guildId: string }
  /** A user became a member: subscribe their sessions and send them the guild. */
  | { kind: 'guild-join'; guildId: string; userId: string }
  /** A user stopped being a member (left or kicked). */
  | { kind: 'guild-leave'; guildId: string; userId: string }
  | { kind: 'guild-delete'; guildId: string }
  /** Presence changed; `guildIds` are the guilds whose members should hear about it. */
  | { kind: 'presence'; userId: string; status: PresenceStatus; guildIds: string[] }
  /** What a user is doing changed: told to the guilds they are in. */
  | { kind: 'activity'; userId: string; activity: Activity | null; guildIds: string[] }
  /** A login session was revoked: drop its gateway connections (`null` = all of the user's). */
  | { kind: 'session-revoked'; userId: string; sessionId: string | null };

export type BusListener = (message: BusMessage) => void;

/** Typed facade over the Redis channel that fans gateway messages out to every instance. */
export class GatewayBus {
  private readonly listeners = new Set<BusListener>();

  constructor(
    private readonly redis: Redis,
    private readonly subscriber: Redis,
  ) {}

  async start(): Promise<void> {
    this.subscriber.on('message', (channel, payload) => {
      if (channel !== CHANNEL) return;
      const message = JSON.parse(payload) as BusMessage;
      for (const listener of this.listeners) listener(message);
    });
    await this.subscriber.subscribe(CHANNEL);
  }

  subscribe(listener: BusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async publish(message: BusMessage): Promise<void> {
    await this.redis.publish(CHANNEL, JSON.stringify(message));
  }

  /** Publishes a guild event; with `channelId` only members who can view that channel get it. */
  event<T extends GatewayEventName>(
    guildId: string,
    t: T,
    d: GatewayEventInput<T>,
    channelId?: string,
  ): Promise<void> {
    return this.publish({ kind: 'event', guildId, channelId, t, d });
  }

  /** Publishes a guild event to an explicit list of members. */
  eventTo<T extends GatewayEventName>(
    guildId: string,
    userIds: string[],
    t: T,
    d: GatewayEventInput<T>,
  ): Promise<void> {
    return this.publish({ kind: 'event', guildId, userIds, t, d });
  }

  userEvent<T extends GatewayEventName>(
    userId: string,
    t: T,
    d: GatewayEventInput<T>,
  ): Promise<void> {
    return this.publish({ kind: 'user-event', userId, t, d });
  }

  sync(guildId: string): Promise<void> {
    return this.publish({ kind: 'guild-sync', guildId });
  }
}
