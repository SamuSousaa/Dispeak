import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  MEETING_EMPTY_GRACE_SECONDS,
  MEETING_MAX_PARTICIPANTS,
  MEETING_MAX_WAITING,
  meetingHelloSchema,
  meetingRoom,
  type InternalVoicePeer,
  type MeetingKnockResponse,
  type MeetingMessage,
  type MeetingParticipant,
  type MeetingPreview,
  type MeetingServerFrame,
  type MeetingState,
  type VoiceTokenResponse,
} from '@frequencia/shared';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from 'ws';
import type { Config } from '../../config';
import { schema, type Database } from '../../db/client';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../errors';
import { buildIceServers } from '../../lib/ice';
import type { Redis } from '../../redis';
import type { MediaLink, VoiceStateEvent } from '../voice/media-link';
import { signVoiceToken } from '../voice/voice-token';

const CHANNEL = 'frequencia:meetings';
/** Every meeting there is, for the sweep and for a resync with the media service. */
const ALL = 'meetings:all';
/** Meetings whose call is empty, scored by when it became so (ms). */
const EMPTY = 'meetings:empty';
const meetingKey = (id: string) => `meeting:${id}`;
const participantsKey = (id: string) => `meeting:${id}:participants`;
const waitingKey = (id: string) => `meeting:${id}:waiting`;
const messagesKey = (id: string) => `meeting:${id}:messages`;
const callKey = (id: string) => `meeting:${id}:call`;
const eventKey = (eventId: string) => `meeting:event:${eventId}`;

/** Messages a meeting keeps; the oldest go first. */
const MAX_MESSAGES = 200;
const SWEEP_MS = 10_000;
/** A socket that does not say who it is within this is closed. */
const HELLO_TIMEOUT_MS = 10_000;

interface MeetingRecord {
  id: string;
  hostUserId: string;
  hostName: string;
  createdAt: string;
}

interface Person {
  id: string;
  name: string;
  userId: string | null;
  /** SHA-256 of the secret half of the person's key. */
  secret: string;
}

interface ParticipantRecord extends Person {
  host: boolean;
  /** Muted by the host: their token does not let them speak. Absent in older records. */
  muted?: boolean;
}

interface KnockRecord extends Person {
  at: string;
}

/** What one API instance tells the others (and itself) about a meeting. */
type MeetingNews =
  | { meetingId: string; kind: 'changed' }
  | { meetingId: string; kind: 'message'; message: MeetingMessage }
  | { meetingId: string; kind: 'admitted'; requestId: string; key: string }
  | { meetingId: string; kind: 'denied'; requestId: string }
  | { meetingId: string; kind: 'removed'; participantId: string }
  | { meetingId: string; kind: 'ended' };

interface Connection {
  socket: WebSocket;
  /** A participant inside, or a person at the door. */
  kind: 'member' | 'waiting';
  personId: string;
}

export interface MeetingDeps {
  db: Database;
  redis: Redis;
  subscriber: Redis;
  config: Config;
  log: FastifyBaseLogger;
}

const newId = (prefix: string) => `${prefix}${randomBytes(9).toString('base64url')}`;
const hash = (secret: string) => createHash('sha256').update(secret).digest('hex');

/** Splits a key into the person it names and its secret; `null` when it is not a key. */
function parseKey(key: string): { id: string; secret: string } | null {
  const dot = key.indexOf('.');
  if (dot <= 0 || dot === key.length - 1) return null;
  return { id: key.slice(0, dot), secret: key.slice(dot + 1) };
}

function secretMatches(person: Person, secret: string): boolean {
  const expected = Buffer.from(person.secret, 'hex');
  const given = Buffer.from(hash(secret), 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Meetings live in Redis only: the meeting, who was let in, who waits at the door, the chat
 * and who is in the call. Nothing of them reaches Postgres, and ending one deletes it all.
 * The call is the media service room `meet:<id>`; its joins and leaves come through the same
 * events as the voice channels'. Each API instance keeps the sockets opened to it and hears
 * about changes from the others over Redis pub/sub.
 */
export class MeetingService {
  private media: MediaLink | null = null;
  private readonly sockets = new Map<string, Set<Connection>>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: MeetingDeps) {}

  attach(media: MediaLink): void {
    this.media = media;
  }

  async start(): Promise<void> {
    this.deps.subscriber.on('message', (channel, payload) => {
      if (channel !== CHANNEL) return;
      void this.deliver(JSON.parse(payload) as MeetingNews).catch((error: unknown) => {
        this.deps.log.warn({ err: error }, 'meeting news not delivered');
      });
    });
    await this.deps.subscriber.subscribe(CHANNEL);
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.sweepTimer.unref();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const connections of this.sockets.values()) {
      for (const connection of connections) connection.socket.close();
    }
    this.sockets.clear();
  }

  // --- REST ---------------------------------------------------------------------------------

  /** A new meeting, its host already inside. */
  async create(userId: string): Promise<{ id: string; key: string }> {
    const hostName = await this.nameOf(userId);
    const id = randomBytes(16).toString('base64url');
    const record: MeetingRecord = {
      id,
      hostUserId: userId,
      hostName,
      createdAt: new Date().toISOString(),
    };
    const { redis } = this.deps;
    await redis.set(meetingKey(id), JSON.stringify(record));
    await redis.sadd(ALL, id);
    // Empty until its host joins the call: an abandoned link goes away like an ended call.
    await redis.zadd(EMPTY, Date.now(), id);
    const key = await this.addParticipant(id, { name: hostName, userId, host: true });
    return { id, key };
  }

  async preview(id: string): Promise<MeetingPreview> {
    const meeting = await this.meeting(id);
    return { id, hostName: meeting.hostName };
  }

  /**
   * Asks to come in. The host, and anyone with an account who was let in before and not
   * removed, comes straight back in (from another tab or device, after losing their key);
   * anyone else waits until someone inside answers.
   */
  async knock(
    id: string,
    who: { userId: string | null; name?: string | undefined },
  ): Promise<MeetingKnockResponse> {
    const meeting = await this.meeting(id);
    const name = who.userId ? await this.nameOf(who.userId) : who.name;
    if (!name) throw badRequest('a name is required');
    if (who.userId) {
      const known = await this.participantOfUser(id, who.userId);
      if (known) return { status: 'admitted', key: await this.rekey(id, known) };
      if (who.userId === meeting.hostUserId) {
        return {
          status: 'admitted',
          key: await this.addParticipant(id, { name, userId: who.userId, host: true }),
        };
      }
    }
    const { redis } = this.deps;
    if ((await redis.hlen(waitingKey(id))) >= MEETING_MAX_WAITING) {
      throw conflict('too many people are waiting to come in');
    }
    const secret = randomBytes(24).toString('base64url');
    const knock: KnockRecord = {
      id: newId('r'),
      name,
      userId: who.userId,
      secret: hash(secret),
      at: new Date().toISOString(),
    };
    await redis.hset(waitingKey(id), knock.id, JSON.stringify(knock));
    await this.publish({ meetingId: id, kind: 'changed' });
    return { status: 'waiting', requestKey: `${knock.id}.${secret}` };
  }

  /** Everything someone inside sees. */
  async state(id: string, key: string): Promise<MeetingState> {
    const self = await this.participant(id, key);
    return { ...(await this.snapshot(id)), selfId: self.id };
  }

  /** Lets someone at the door in; anyone inside may. */
  async admit(id: string, key: string, requestId: string): Promise<void> {
    await this.participant(id, key);
    const knock = await this.takeKnock(id, requestId);
    if ((await this.deps.redis.hlen(participantsKey(id))) >= MEETING_MAX_PARTICIPANTS) {
      await this.deps.redis.hset(waitingKey(id), knock.id, JSON.stringify(knock));
      throw conflict('the meeting is full');
    }
    const admitted = await this.addParticipant(id, {
      name: knock.name,
      userId: knock.userId,
      host: false,
    });
    await this.publish({ meetingId: id, kind: 'admitted', requestId, key: admitted });
    await this.publish({ meetingId: id, kind: 'changed' });
  }

  async deny(id: string, key: string, requestId: string): Promise<void> {
    await this.participant(id, key);
    await this.takeKnock(id, requestId);
    await this.publish({ meetingId: id, kind: 'denied', requestId });
    await this.publish({ meetingId: id, kind: 'changed' });
  }

  async say(id: string, key: string, content: string): Promise<MeetingMessage> {
    const self = await this.participant(id, key);
    const message: MeetingMessage = {
      id: newId('m'),
      participantId: self.id,
      name: self.name,
      content,
      at: new Date().toISOString(),
    };
    const { redis } = this.deps;
    await redis.rpush(messagesKey(id), JSON.stringify(message));
    await redis.ltrim(messagesKey(id), -MAX_MESSAGES, -1);
    await this.publish({ meetingId: id, kind: 'message', message });
    return message;
  }

  /** The token that lets someone inside into the call. */
  async voiceToken(id: string, key: string): Promise<VoiceTokenResponse> {
    const self = await this.participant(id, key);
    const { config } = this.deps;
    const token = await signVoiceToken(
      { sub: self.id, name: self.name, room: meetingRoom(id), speak: !self.muted, stream: true },
      { secret: config.MEDIA_SHARED_SECRET, ttlSeconds: config.VOICE_TOKEN_TTL_SECONDS },
    );
    return { token, iceServers: buildIceServers(config, self.id) };
  }

  /** Ends the meeting for everyone; only its host may. */
  async end(id: string, key: string): Promise<void> {
    const self = await this.participant(id, key);
    if (!self.host) throw forbidden('only the host ends the meeting');
    await this.finish(id);
  }

  /**
   * The host mutes someone for everyone, or gives their microphone back. The media service
   * drops them with "permissions changed"; they come back on their own with a token that says
   * whether they may speak, so the mute holds whatever their browser does.
   */
  async setMuted(id: string, key: string, targetId: string, muted: boolean): Promise<void> {
    const target = await this.targetOfHost(id, key, targetId);
    if (Boolean(target.muted) === muted) return;
    await this.deps.redis.hset(
      participantsKey(id),
      target.id,
      JSON.stringify({ ...target, muted } satisfies ParticipantRecord),
    );
    await this.disconnect(id, target.id, 'permissions');
    await this.publish({ meetingId: id, kind: 'changed' });
  }

  /** The host takes someone out of the meeting; to come back they knock again. */
  async remove(id: string, key: string, targetId: string): Promise<void> {
    const target = await this.targetOfHost(id, key, targetId);
    const { redis } = this.deps;
    await redis.hdel(participantsKey(id), target.id);
    await this.disconnect(id, target.id, 'kicked');
    await this.publish({ meetingId: id, kind: 'removed', participantId: target.id });
    await this.publish({ meetingId: id, kind: 'changed' });
  }

  /** Someone the host acts on: never the host, and only by the host. */
  private async targetOfHost(id: string, key: string, targetId: string) {
    const self = await this.participant(id, key);
    if (!self.host) throw forbidden('only the host does that');
    const raw = await this.deps.redis.hget(participantsKey(id), targetId);
    const target = raw ? (JSON.parse(raw) as ParticipantRecord) : null;
    if (!target) throw notFound('participant');
    if (target.host) throw forbidden('the host is out of reach');
    return target;
  }

  private async disconnect(id: string, participantId: string, reason: 'kicked' | 'permissions') {
    await this.media
      ?.request('disconnectUser', { userId: participantId, roomId: meetingRoom(id), reason })
      .catch((error: unknown) => {
        this.deps.log.warn({ err: error, meetingId: id }, 'could not reach the meeting call');
      });
  }

  // --- the call -----------------------------------------------------------------------------

  /** Whether a media service room is a meeting's. */
  static owns(roomId: string): boolean {
    return roomId.startsWith(meetingRoom(''));
  }

  /** A join or leave in a meeting's call, as the media service reports it. */
  async applyVoiceState(event: VoiceStateEvent): Promise<void> {
    const { redis } = this.deps;
    const claimed = await redis.set(eventKey(event.eventId), '1', 'EX', 60, 'NX');
    if (!claimed) return;
    const id = event.roomId.slice(meetingRoom('').length);
    if (!(await redis.exists(meetingKey(id)))) return;
    const before = await redis.sismember(callKey(id), event.userId);
    if (event.state === null) await redis.srem(callKey(id), event.userId);
    else await redis.sadd(callKey(id), event.userId);
    await this.markEmptiness(id);
    if (before !== (event.state === null ? 0 : 1)) {
      await this.publish({ meetingId: id, kind: 'changed' });
    }
  }

  /** Rebuilds who is in each call from a media service snapshot, after the link reopens. */
  async resync(peers: InternalVoicePeer[]): Promise<void> {
    const { redis } = this.deps;
    const byMeeting = new Map<string, string[]>();
    for (const peer of peers) {
      if (!MeetingService.owns(peer.roomId)) continue;
      const id = peer.roomId.slice(meetingRoom('').length);
      byMeeting.set(id, [...(byMeeting.get(id) ?? []), peer.userId]);
    }
    for (const id of await redis.smembers(ALL)) {
      const inCall = byMeeting.get(id) ?? [];
      await redis.del(callKey(id));
      if (inCall.length > 0) await redis.sadd(callKey(id), ...inCall);
      await this.markEmptiness(id);
      await this.publish({ meetingId: id, kind: 'changed' });
    }
  }

  /** Ends the meetings whose call has been empty for longer than the grace period. */
  async sweep(now = Date.now()): Promise<void> {
    const { redis } = this.deps;
    try {
      const due = await redis.zrangebyscore(EMPTY, 0, now - MEETING_EMPTY_GRACE_SECONDS * 1000);
      for (const id of due) {
        // Only the instance that removes it ends it.
        if ((await redis.zrem(EMPTY, id)) === 1) await this.finish(id);
      }
      // A meeting deleted by hand, or half-written: nothing to keep track of.
      for (const id of await redis.smembers(ALL)) {
        if (!(await redis.exists(meetingKey(id)))) await redis.srem(ALL, id);
      }
    } catch (error) {
      this.deps.log.warn({ err: error }, 'meeting sweep failed');
    }
  }

  // --- sockets ------------------------------------------------------------------------------

  /** A socket from someone inside (live state and chat) or at the door (the answer). */
  accept(socket: WebSocket, meetingId: string): void {
    const timer = setTimeout(() => socket.close(4401, 'hello expected'), HELLO_TIMEOUT_MS);
    socket.once('message', (raw) => {
      clearTimeout(timer);
      void this.hello(socket, meetingId, raw.toString()).catch((error: unknown) => {
        if (!(error instanceof AppError)) {
          this.deps.log.warn({ err: error }, 'meeting socket failed');
        }
        this.send(socket, { t: 'ended', d: { reason: 'gone' } });
        socket.close(4404, 'gone');
      });
    });
    socket.once('close', () => clearTimeout(timer));
  }

  private async hello(socket: WebSocket, meetingId: string, raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const hello = meetingHelloSchema.parse(parsed);
    let connection: Connection;
    if ('key' in hello) {
      const self = await this.participant(meetingId, hello.key);
      connection = { socket, kind: 'member', personId: self.id };
      this.send(socket, {
        t: 'state',
        d: { ...(await this.snapshot(meetingId)), selfId: self.id },
      });
    } else {
      const knock = await this.knockOf(meetingId, hello.requestKey);
      connection = { socket, kind: 'waiting', personId: knock.id };
    }
    let connections = this.sockets.get(meetingId);
    if (!connections) {
      connections = new Set();
      this.sockets.set(meetingId, connections);
    }
    connections.add(connection);
    socket.on('close', () => {
      connections.delete(connection);
      if (connections.size === 0) this.sockets.delete(meetingId);
      // Someone who stops waiting leaves the door.
      if (connection.kind === 'waiting') void this.leaveDoor(meetingId, connection.personId);
    });
  }

  private async leaveDoor(meetingId: string, requestId: string): Promise<void> {
    const removed = await this.deps.redis.hdel(waitingKey(meetingId), requestId).catch(() => 0);
    if (removed) await this.publish({ meetingId, kind: 'changed' });
  }

  private async deliver(news: MeetingNews): Promise<void> {
    const connections = this.sockets.get(news.meetingId);
    if (!connections) return;
    switch (news.kind) {
      case 'changed': {
        const members = [...connections].filter((c) => c.kind === 'member');
        if (members.length === 0) return;
        const snapshot = await this.snapshot(news.meetingId);
        for (const member of members) {
          this.send(member.socket, { t: 'state', d: { ...snapshot, selfId: member.personId } });
        }
        return;
      }
      case 'message':
        for (const c of connections) {
          if (c.kind === 'member') this.send(c.socket, { t: 'message', d: news.message });
        }
        return;
      case 'admitted':
      case 'denied':
        for (const c of connections) {
          if (c.kind !== 'waiting' || c.personId !== news.requestId) continue;
          // Answered: closing it must not take the person off the door a second time.
          c.kind = 'member';
          this.send(
            c.socket,
            news.kind === 'admitted' ? { t: 'admitted', d: { key: news.key } } : { t: 'denied' },
          );
          c.socket.close(1000, news.kind);
        }
        return;
      case 'removed':
        for (const c of connections) {
          if (c.kind !== 'member' || c.personId !== news.participantId) continue;
          this.send(c.socket, { t: 'ended', d: { reason: 'removed' } });
          c.socket.close(1000, 'removed');
        }
        return;
      case 'ended':
        for (const c of connections) {
          this.send(c.socket, { t: 'ended', d: { reason: 'ended' } });
          c.socket.close(1000, 'ended');
        }
        this.sockets.delete(news.meetingId);
        return;
    }
  }

  private send(socket: WebSocket, frame: MeetingServerFrame): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
  }

  // --- storage ------------------------------------------------------------------------------

  private publish(news: MeetingNews): Promise<number> {
    return this.deps.redis.publish(CHANNEL, JSON.stringify(news));
  }

  private async meeting(id: string): Promise<MeetingRecord> {
    const raw = await this.deps.redis.get(meetingKey(id));
    if (!raw) throw notFound('meeting');
    return JSON.parse(raw) as MeetingRecord;
  }

  /** The participant a key names; 404 when the meeting is over, 403 for a bad key. */
  private async participant(id: string, key: string): Promise<ParticipantRecord> {
    await this.meeting(id);
    const parsed = parseKey(key);
    const raw = parsed ? await this.deps.redis.hget(participantsKey(id), parsed.id) : null;
    const person = raw ? (JSON.parse(raw) as ParticipantRecord) : null;
    if (!parsed || !person || !secretMatches(person, parsed.secret)) {
      throw forbidden('not in this meeting');
    }
    return person;
  }

  private async knockOf(id: string, requestKey: string): Promise<KnockRecord> {
    await this.meeting(id);
    const parsed = parseKey(requestKey);
    const raw = parsed ? await this.deps.redis.hget(waitingKey(id), parsed.id) : null;
    const knock = raw ? (JSON.parse(raw) as KnockRecord) : null;
    if (!parsed || !knock || !secretMatches(knock, parsed.secret)) throw notFound('request');
    return knock;
  }

  private async takeKnock(id: string, requestId: string): Promise<KnockRecord> {
    const { redis } = this.deps;
    const raw = await redis.hget(waitingKey(id), requestId);
    // Two people inside answering at once: only the first answer counts.
    if (!raw || (await redis.hdel(waitingKey(id), requestId)) === 0) throw notFound('request');
    return JSON.parse(raw) as KnockRecord;
  }

  private async addParticipant(
    id: string,
    person: { name: string; userId: string | null; host: boolean },
  ): Promise<string> {
    const secret = randomBytes(24).toString('base64url');
    const record: ParticipantRecord = { id: newId('p'), ...person, secret: hash(secret) };
    await this.deps.redis.hset(participantsKey(id), record.id, JSON.stringify(record));
    return `${record.id}.${secret}`;
  }

  private async participantOfUser(id: string, userId: string): Promise<ParticipantRecord | null> {
    const people = await this.deps.redis.hvals(participantsKey(id));
    return (
      people
        .map((raw) => JSON.parse(raw) as ParticipantRecord)
        .find((person) => person.userId === userId) ?? null
    );
  }

  /** A new key for someone already let in; the one they had stops working. */
  private async rekey(id: string, person: ParticipantRecord): Promise<string> {
    const secret = randomBytes(24).toString('base64url');
    const record: ParticipantRecord = { ...person, secret: hash(secret) };
    await this.deps.redis.hset(participantsKey(id), record.id, JSON.stringify(record));
    return `${record.id}.${secret}`;
  }

  private async snapshot(id: string): Promise<Omit<MeetingState, 'selfId'>> {
    const { redis } = this.deps;
    const meeting = await this.meeting(id);
    const [people, knocks, messages, inCall] = await Promise.all([
      redis.hvals(participantsKey(id)),
      redis.hvals(waitingKey(id)),
      redis.lrange(messagesKey(id), 0, -1),
      redis.smembers(callKey(id)),
    ]);
    const present = new Set(inCall);
    const participants: MeetingParticipant[] = people
      .map((raw) => JSON.parse(raw) as ParticipantRecord)
      .map(({ id: personId, name, userId, host, muted }) => ({
        id: personId,
        name,
        userId,
        host,
        mutedByHost: Boolean(muted),
        inCall: present.has(personId),
      }))
      .sort((a, b) => Number(b.inCall) - Number(a.inCall) || a.name.localeCompare(b.name, 'pt-BR'));
    const waiting = knocks
      .map((raw) => JSON.parse(raw) as KnockRecord)
      .sort((a, b) => a.at.localeCompare(b.at))
      .map(({ id: knockId, name, userId, at }) => ({
        id: knockId,
        name,
        hasAccount: userId !== null,
        at,
      }));
    return {
      id,
      hostName: meeting.hostName,
      participants,
      waiting,
      messages: messages.map((raw) => JSON.parse(raw) as MeetingMessage),
    };
  }

  private async markEmptiness(id: string): Promise<void> {
    const { redis } = this.deps;
    if ((await redis.scard(callKey(id))) > 0) await redis.zrem(EMPTY, id);
    // NX: an empty call keeps the moment it emptied, not the latest leave.
    else await redis.zadd(EMPTY, 'NX', Date.now(), id);
  }

  /** Deletes the meeting and everything in it, closes its call and tells everyone. */
  private async finish(id: string): Promise<void> {
    const { redis } = this.deps;
    const removed = await redis.del(
      meetingKey(id),
      participantsKey(id),
      waitingKey(id),
      messagesKey(id),
      callKey(id),
    );
    await redis.srem(ALL, id);
    await redis.zrem(EMPTY, id);
    if (removed === 0) return;
    await this.media?.request('closeRoom', { roomId: meetingRoom(id) }).catch((error: unknown) => {
      this.deps.log.warn({ err: error, meetingId: id }, 'could not close the meeting call');
    });
    await this.publish({ meetingId: id, kind: 'ended' });
  }

  private async nameOf(userId: string): Promise<string> {
    const [row] = await this.deps.db
      .select({ displayName: schema.users.displayName })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    if (!row) throw notFound('user');
    return row.displayName.slice(0, 32);
  }
}
