import { randomUUID } from 'node:crypto';
import {
  GatewayCloseCode,
  gatewayClientFrameSchema,
  GatewayOp,
  type GatewayEventInput,
  type GatewayEventName,
} from '@frequencia/shared';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from 'ws';
import type { Config } from '../config';
import { schema, type Database } from '../db/client';
import type { AuthService } from '../modules/auth/service';
import type { ConversationService } from '../modules/conversations/service';
import type { UserSettingsService } from '../modules/users/settings';
import { loadGuildLiveData, type LiveState } from '../modules/guilds/live';
import {
  canViewChannel,
  guildPayloadFor,
  loadGuildSnapshot,
  type GuildSnapshot,
} from '../modules/guilds/snapshot';
import type { BusMessage, GatewayBus } from './bus';

const { guildMembers } = schema;

/** Dispatches kept per session so a resume can replay what the client missed. */
const REPLAY_BUFFER_SIZE = 500;
const RATE_WINDOW_MS = 10_000;
/** Events after which the cached guild snapshot no longer matches the database. */
const STRUCTURAL_EVENTS = new Set<GatewayEventName>([
  'GUILD_UPDATE',
  'CHANNEL_CREATE',
  'CHANNEL_UPDATE',
  'CHANNEL_DELETE',
  'MEMBER_ADD',
  'MEMBER_UPDATE',
  'MEMBER_REMOVE',
]);

interface BufferedFrame {
  s: number;
  raw: string;
}

/** One logical gateway session. It outlives its socket so the client can resume it. */
class Session {
  readonly id = randomUUID();
  readonly guildIds = new Set<string>();
  socket: WebSocket | null = null;
  seq = 0;
  /** READY has been sent; events arriving earlier are held back until then. */
  ready = false;
  expireTimer: NodeJS.Timeout | null = null;
  private readonly buffer: BufferedFrame[] = [];
  private readonly held: Array<[GatewayEventName, unknown]> = [];

  constructor(
    readonly userId: string,
    /** Login session (refresh-token family) that authenticated this connection. */
    readonly authSessionId: string,
  ) {}

  dispatch<T extends GatewayEventName>(t: T, d: GatewayEventInput<T>): void {
    if (!this.ready) {
      this.held.push([t, d]);
      return;
    }
    this.write(t, d);
  }

  /** Sends READY first, then whatever arrived while it was being built. */
  open<T extends GatewayEventName>(t: T, d: GatewayEventInput<T>): void {
    this.ready = true;
    this.write(t, d);
    for (const [name, data] of this.held.splice(0)) this.write(name, data);
  }

  /** Whether every dispatch after `seq` is still in the replay buffer. */
  canReplayFrom(seq: number): boolean {
    if (seq > this.seq) return false;
    if (seq === this.seq) return true;
    const oldest = this.buffer[0];
    return oldest !== undefined && oldest.s <= seq + 1;
  }

  replayFrom(seq: number): void {
    for (const frame of this.buffer) {
      if (frame.s > seq) this.send(frame.raw);
    }
  }

  private write(t: GatewayEventName, d: unknown): void {
    this.seq += 1;
    const raw = JSON.stringify({ op: GatewayOp.Dispatch, s: this.seq, t, d });
    this.buffer.push({ s: this.seq, raw });
    if (this.buffer.length > REPLAY_BUFFER_SIZE) this.buffer.shift();
    this.send(raw);
  }

  private send(raw: string): void {
    if (this.socket?.readyState === 1) this.socket.send(raw);
  }
}

export interface GatewayHubDeps {
  db: Database;
  bus: GatewayBus;
  auth: AuthService;
  userSettings: UserSettingsService;
  conversations: ConversationService;
  live: LiveState;
  config: Config;
  log: FastifyBaseLogger;
}

/**
 * The realtime gateway of one API instance: owns the sockets connected to it and delivers
 * the messages every instance publishes on the bus to the sessions they concern.
 */
export class GatewayHub {
  private readonly sessions = new Map<string, Session>();
  private readonly byUser = new Map<string, Set<Session>>();
  private readonly byGuild = new Map<string, Set<Session>>();
  private readonly snapshots = new Map<string, Promise<GuildSnapshot | null>>();
  /** Per-guild promise chains: bus messages for one guild are handled strictly in order. */
  private readonly queues = new Map<string, Promise<void>>();
  private readonly sockets = new Set<WebSocket>();
  private stopListening: (() => void) | null = null;

  constructor(private readonly deps: GatewayHubDeps) {}

  get connectionCount(): number {
    return this.sockets.size;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Distinct users with at least one session on this instance. */
  get userCount(): number {
    return this.byUser.size;
  }

  start(): void {
    this.stopListening = this.deps.bus.subscribe((message) => this.onBusMessage(message));
  }

  async close(): Promise<void> {
    this.stopListening?.();
    for (const socket of this.sockets) socket.close(1001, 'server shutting down');
    await Promise.all([...this.sessions.values()].map((session) => this.destroy(session)));
  }

  // --- connections --------------------------------------------------------------------------

  accept(socket: WebSocket): void {
    const { config, log } = this.deps;
    const interval = config.GATEWAY_HEARTBEAT_MS;
    this.sockets.add(socket);

    let session: Session | null = null;
    let authenticating = false;
    let lastBeat = Date.now();
    let windowStart = Date.now();
    let framesInWindow = 0;

    const send = (frame: object) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
    };
    send({ op: GatewayOp.Hello, d: { heartbeatInterval: interval } });

    // A client must authenticate and then keep beating; otherwise the socket is dropped.
    const watchdog = setInterval(
      () => {
        const silentFor = Date.now() - lastBeat;
        if (!session && !authenticating && silentFor > interval) {
          socket.close(GatewayCloseCode.NotAuthenticated, 'identify timeout');
        } else if (silentFor > interval * 2) {
          socket.close(GatewayCloseCode.SessionTimedOut, 'heartbeat timeout');
        }
      },
      Math.max(50, Math.floor(interval / 2)),
    );

    socket.on('message', (data, isBinary) => {
      const now = Date.now();
      if (now - windowStart > RATE_WINDOW_MS) {
        windowStart = now;
        framesInWindow = 0;
      }
      framesInWindow += 1;
      if (framesInWindow > config.GATEWAY_RATE_LIMIT) {
        socket.close(GatewayCloseCode.RateLimited, 'rate limited');
        return;
      }

      let json: unknown;
      try {
        json = isBinary ? undefined : JSON.parse(data.toString());
      } catch {
        json = undefined;
      }
      const frame = gatewayClientFrameSchema.safeParse(json);
      if (!frame.success) {
        socket.close(GatewayCloseCode.DecodeError, 'invalid frame');
        return;
      }

      switch (frame.data.op) {
        case GatewayOp.Heartbeat:
          lastBeat = now;
          send({ op: GatewayOp.HeartbeatAck });
          if (session) void this.deps.live.presence.touch(session.userId, session.id);
          break;

        case GatewayOp.Identify:
        case GatewayOp.Resume: {
          if (session || authenticating) {
            socket.close(GatewayCloseCode.AlreadyAuthenticated, 'already authenticated');
            return;
          }
          authenticating = true;
          lastBeat = now;
          const request = frame.data;
          void (async () => {
            const claims = await this.deps.auth.authenticate(request.d.token);
            if (!claims) {
              socket.close(GatewayCloseCode.AuthenticationFailed, 'invalid token');
              return;
            }
            if (request.op === GatewayOp.Resume) {
              const previous = this.sessions.get(request.d.sessionId);
              if (
                !previous ||
                previous.userId !== claims.userId ||
                !previous.canReplayFrom(request.d.seq)
              ) {
                // Not resumable here: the client falls back to a fresh identify.
                authenticating = false;
                send({ op: GatewayOp.InvalidSession, d: { resumable: false } });
                return;
              }
              session = this.reattach(previous, socket, request.d.seq);
            } else {
              session = await this.identify(claims.userId, claims.sessionId, socket);
            }
            authenticating = false;
            // The socket may have closed while we were working.
            if (socket.readyState !== socket.OPEN) this.detach(session, socket);
          })().catch((error: unknown) => {
            log.error({ err: error }, 'gateway authentication failed');
            socket.close(1011, 'internal error');
          });
          break;
        }
      }
    });

    socket.on('error', (error) => log.debug({ err: error }, 'gateway socket error'));
    socket.on('close', () => {
      clearInterval(watchdog);
      this.sockets.delete(socket);
      if (session) this.detach(session, socket);
    });
  }

  private async identify(
    userId: string,
    authSessionId: string,
    socket: WebSocket,
  ): Promise<Session> {
    const { db, live, auth, userSettings, conversations } = this.deps;
    const session = new Session(userId, authSessionId);
    session.socket = socket;
    this.sessions.set(session.id, session);
    this.index(this.byUser, userId, session);

    const memberships = await db
      .select({ guildId: guildMembers.guildId })
      .from(guildMembers)
      .where(eq(guildMembers.userId, userId))
      .orderBy(guildMembers.joinedAt);
    // Subscribe before loading, so nothing published meanwhile is lost (it is held back).
    for (const { guildId } of memberships) this.subscribe(session, guildId);

    const cameOnline = await live.presence.connect(userId, session.id);
    const [user, settings, blockedUserIds, guilds] = await Promise.all([
      auth.getUser(userId),
      userSettings.get(userId),
      conversations.blockedIds(userId),
      Promise.all(memberships.map(({ guildId }) => this.payloadFor(guildId, userId))),
    ]);
    if (!user) throw new Error('authenticated user no longer exists');

    session.open('READY', {
      sessionId: session.id,
      user,
      settings,
      blockedUserIds,
      guilds: guilds.filter((guild) => guild !== null),
    });
    if (cameOnline && user.presence !== 'invisible') {
      await this.deps.bus.publish({
        kind: 'presence',
        userId,
        status: 'online',
        guildIds: [...session.guildIds],
      });
    }
    return session;
  }

  private reattach(session: Session, socket: WebSocket, seq: number): Session {
    if (session.expireTimer) clearTimeout(session.expireTimer);
    session.expireTimer = null;
    // A stale socket of the same session must not keep receiving.
    if (session.socket && session.socket !== socket)
      session.socket.close(4000, 'resumed elsewhere');
    session.socket = socket;
    session.replayFrom(seq);
    session.dispatch('RESUMED', {});
    return session;
  }

  /** The socket went away: keep the session around for a while so it can be resumed. */
  private detach(session: Session, socket: WebSocket): void {
    if (session.socket !== socket) return;
    session.socket = null;
    if (session.expireTimer) clearTimeout(session.expireTimer);
    session.expireTimer = setTimeout(
      () => void this.destroy(session),
      this.deps.config.GATEWAY_RESUME_WINDOW_MS,
    );
  }

  private async destroy(session: Session): Promise<void> {
    if (!this.sessions.delete(session.id)) return;
    if (session.expireTimer) clearTimeout(session.expireTimer);
    this.unindex(this.byUser, session.userId, session);
    const guildIds = [...session.guildIds];
    for (const guildId of guildIds) this.unsubscribe(session, guildId);

    try {
      const wentOffline = await this.deps.live.presence.disconnect(session.userId, session.id);
      if (wentOffline) {
        await this.deps.bus.publish({
          kind: 'presence',
          userId: session.userId,
          status: 'offline',
          guildIds,
        });
      }
    } catch (error) {
      this.deps.log.debug({ err: error }, 'failed to clear presence');
    }
  }

  // --- bus ----------------------------------------------------------------------------------

  private onBusMessage(message: BusMessage): void {
    switch (message.kind) {
      case 'user-event':
        for (const session of this.byUser.get(message.userId) ?? []) {
          session.dispatch(message.t, message.d as never);
        }
        break;

      case 'presence': {
        const audience = new Set<Session>();
        for (const guildId of message.guildIds) {
          for (const session of this.byGuild.get(guildId) ?? []) audience.add(session);
        }
        for (const session of audience) {
          // Users learn their own presence from READY, not from an echo.
          if (session.userId === message.userId) continue;
          session.dispatch('PRESENCE_UPDATE', { userId: message.userId, status: message.status });
        }
        break;
      }

      case 'session-revoked':
        for (const session of [...(this.byUser.get(message.userId) ?? [])]) {
          if (message.sessionId && session.authSessionId !== message.sessionId) continue;
          session.socket?.close(GatewayCloseCode.AuthenticationFailed, 'session revoked');
          void this.destroy(session);
        }
        break;

      default:
        this.enqueue(message.guildId, () => this.onGuildMessage(message));
    }
  }

  private async onGuildMessage(message: Extract<BusMessage, { guildId: string }>): Promise<void> {
    const { guildId } = message;
    switch (message.kind) {
      case 'event': {
        if (STRUCTURAL_EVENTS.has(message.t)) this.snapshots.delete(guildId);
        const audience = this.byGuild.get(guildId);
        if (!audience?.size) return;
        if (message.userIds) {
          const recipients = new Set(message.userIds);
          for (const session of audience) {
            if (recipients.has(session.userId)) session.dispatch(message.t, message.d as never);
          }
          return;
        }
        if (!message.channelId) {
          for (const session of audience) session.dispatch(message.t, message.d as never);
          return;
        }
        // Channel-scoped events only reach members who can see that channel.
        const channelId = message.channelId;
        const snapshot = await this.snapshot(guildId);
        if (!snapshot?.channels.has(channelId)) return;
        for (const session of audience) {
          if (canViewChannel(snapshot, session.userId, channelId)) {
            session.dispatch(message.t, message.d as never);
          }
        }
        return;
      }

      case 'guild-sync': {
        this.snapshots.delete(guildId);
        const audience = this.byGuild.get(guildId);
        if (!audience?.size) return;
        const snapshot = await this.snapshot(guildId);
        if (!snapshot) return;
        const live = await loadGuildLiveData(this.deps.live, snapshot);
        for (const session of audience) {
          if (!snapshot.members.has(session.userId)) continue;
          session.dispatch('GUILD_SYNC', guildPayloadFor(snapshot, session.userId, live));
        }
        return;
      }

      case 'guild-join': {
        this.snapshots.delete(guildId);
        const sessions = [...(this.byUser.get(message.userId) ?? [])];
        if (sessions.length === 0) return;
        const payload = await this.payloadFor(guildId, message.userId);
        if (!payload) return;
        for (const session of sessions) {
          this.subscribe(session, guildId);
          session.dispatch('GUILD_CREATE', payload);
        }
        return;
      }

      case 'guild-leave':
        this.snapshots.delete(guildId);
        for (const session of this.byUser.get(message.userId) ?? []) {
          if (!session.guildIds.has(guildId)) continue;
          this.unsubscribe(session, guildId);
          session.dispatch('GUILD_DELETE', { id: guildId });
        }
        return;

      case 'guild-delete':
        this.snapshots.delete(guildId);
        for (const session of [...(this.byGuild.get(guildId) ?? [])]) {
          this.unsubscribe(session, guildId);
          session.dispatch('GUILD_DELETE', { id: guildId });
        }
        return;
    }
  }

  private enqueue(guildId: string, task: () => Promise<void>): void {
    const previous = this.queues.get(guildId) ?? Promise.resolve();
    const next = previous.then(task).catch((error: unknown) => {
      this.deps.log.error({ err: error, guildId }, 'failed to deliver gateway message');
    });
    this.queues.set(guildId, next);
    void next.then(() => {
      if (this.queues.get(guildId) === next) this.queues.delete(guildId);
    });
  }

  // --- helpers ------------------------------------------------------------------------------

  private snapshot(guildId: string): Promise<GuildSnapshot | null> {
    let snapshot = this.snapshots.get(guildId);
    if (!snapshot) {
      snapshot = loadGuildSnapshot(this.deps.db, guildId);
      this.snapshots.set(guildId, snapshot);
      snapshot.catch(() => this.snapshots.delete(guildId));
    }
    return snapshot;
  }

  private async payloadFor(guildId: string, userId: string) {
    const snapshot = await this.snapshot(guildId);
    if (!snapshot?.members.has(userId)) return null;
    return guildPayloadFor(snapshot, userId, await loadGuildLiveData(this.deps.live, snapshot));
  }

  private subscribe(session: Session, guildId: string): void {
    session.guildIds.add(guildId);
    this.index(this.byGuild, guildId, session);
  }

  private unsubscribe(session: Session, guildId: string): void {
    session.guildIds.delete(guildId);
    this.unindex(this.byGuild, guildId, session);
  }

  private index(map: Map<string, Set<Session>>, key: string, session: Session): void {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    set.add(session);
  }

  private unindex(map: Map<string, Set<Session>>, key: string, session: Session): void {
    const set = map.get(key);
    if (!set) return;
    set.delete(session);
    if (set.size === 0) map.delete(key);
  }
}
