import {
  MEETING_EMPTY_GRACE_SECONDS,
  MEETING_KEY_HEADER,
  meetingRoom,
  meetingServerFrameSchema,
  meetingSocketPath,
  type MeetingCreated,
  type MeetingKnockResponse,
  type MeetingServerFrame,
  type MeetingState,
} from '@frequencia/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createTestApp, type Account, type TestApp } from './helpers/app';
import { startFakeMedia, type FakeMedia } from './helpers/fake-media';

async function eventually(assertion: () => void | Promise<void>, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

interface MeetingSocket {
  frames: MeetingServerFrame[];
  next: <T extends MeetingServerFrame['t']>(
    t: T,
    predicate?: (frame: Extract<MeetingServerFrame, { t: T }>) => boolean,
  ) => Promise<Extract<MeetingServerFrame, { t: T }>>;
  closed: Promise<number>;
  close: () => void;
}

describe('meetings', () => {
  let media: FakeMedia;
  let t: TestApp;
  const sockets: MeetingSocket[] = [];

  async function connect(meetingId: string, hello: object): Promise<MeetingSocket> {
    const socket = new WebSocket(`${t.wsUrl}/api${meetingSocketPath(meetingId)}`);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const frames: MeetingServerFrame[] = [];
    let read = 0;
    const waiters = new Set<() => void>();
    socket.on('message', (data) => {
      frames.push(meetingServerFrameSchema.parse(JSON.parse(data.toString())));
      for (const wake of waiters) wake();
    });
    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    socket.send(JSON.stringify({ t: 'hello', ...hello }));
    const client: MeetingSocket = {
      frames,
      closed,
      close: () => socket.close(),
      next: (type, predicate) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            waiters.delete(check);
            reject(new Error(`no "${type}" frame`));
          }, 4000);
          function check() {
            while (read < frames.length) {
              const frame = frames[read++] as MeetingServerFrame;
              if (frame.t !== type) continue;
              const typed = frame as Extract<MeetingServerFrame, { t: typeof type }>;
              if (predicate && !predicate(typed)) continue;
              clearTimeout(timer);
              waiters.delete(check);
              resolve(typed);
              return;
            }
          }
          waiters.add(check);
          check();
        }),
    };
    sockets.push(client);
    return client;
  }

  const create = async (host: Account) => {
    const response = await t.request('POST', '/meetings', { token: host.token });
    expect(response.statusCode).toBe(201);
    return response.json<MeetingCreated>();
  };
  const knock = async (meetingId: string, who: { name?: string; token?: string }) =>
    t.request('POST', `/meetings/${meetingId}/knock`, {
      ...(who.token ? { token: who.token } : {}),
      body: who.name ? { name: who.name } : {},
    });
  const as = (key: string) => ({ headers: { [MEETING_KEY_HEADER]: key } });
  const state = async (meetingId: string, key: string) =>
    (await t.request('GET', `/meetings/${meetingId}/state`, as(key))).json<MeetingState>();
  /** A guest asks, the host lets them in: the guest's key. */
  async function guestInside(meeting: MeetingCreated, name = 'Convidada') {
    const asked = (await knock(meeting.id, { name })).json<MeetingKnockResponse>();
    if (asked.status !== 'waiting') throw new Error('expected to wait');
    const door = await connect(meeting.id, { requestKey: asked.requestKey });
    const requestId = asked.requestKey.split('.')[0] ?? '';
    await eventually(async () =>
      expect((await state(meeting.id, meeting.key)).waiting.map((w) => w.id)).toContain(requestId),
    );
    const admitted = await t.request(
      'POST',
      `/meetings/${meeting.id}/waiting/${requestId}/admit`,
      as(meeting.key),
    );
    expect(admitted.statusCode).toBe(204);
    return (await door.next('admitted')).d.key;
  }

  beforeAll(async () => {
    media = await startFakeMedia();
    t = await createTestApp({ MEDIA_INTERNAL_URL: media.url, MEDIA_SHARED_SECRET: media.secret });
    await eventually(() => expect(media.links()).toBe(1));
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
    media.calls.length = 0;
  });

  afterAll(async () => {
    await t.close();
    await media.close();
  });

  it('starts a meeting with its host inside, and shows anyone its link', async () => {
    const host = await t.account('Anfitriã');
    const meeting = await create(host);
    expect(meeting.id).toMatch(/^[A-Za-z0-9_-]{22}$/);

    expect((await t.request('GET', `/meetings/${meeting.id}`)).json()).toEqual({
      id: meeting.id,
      hostName: 'Anfitriã',
    });
    const inside = await state(meeting.id, meeting.key);
    expect(inside.participants).toEqual([
      {
        id: inside.selfId,
        name: 'Anfitriã',
        userId: host.user.id,
        host: true,
        mutedByHost: false,
        inCall: false,
      },
    ]);
    expect((await t.request('POST', '/meetings')).statusCode).toBe(401);
    expect((await t.request('GET', '/meetings/AAAAAAAAAAAAAAAAAAAAAA')).statusCode).toBe(404);
  });

  it('lets a guest in with just a name, once someone inside admits them', async () => {
    const host = await t.account('Anfitriã');
    const meeting = await create(host);
    const watcher = await connect(meeting.id, { key: meeting.key });
    await watcher.next('state');

    const asked = (await knock(meeting.id, { name: 'Visita' })).json<MeetingKnockResponse>();
    expect(asked.status).toBe('waiting');
    if (asked.status !== 'waiting') return;
    // A request key is not a key to the meeting.
    expect(
      (await t.request('GET', `/meetings/${meeting.id}/state`, as(asked.requestKey))).statusCode,
    ).toBe(403);

    const door = await connect(meeting.id, { requestKey: asked.requestKey });
    const seen = await watcher.next('state', (frame) => frame.d.waiting.length === 1);
    expect(seen.d.waiting[0]).toMatchObject({ name: 'Visita', hasAccount: false });

    const requestId = seen.d.waiting[0]?.id ?? '';
    await t.request('POST', `/meetings/${meeting.id}/waiting/${requestId}/admit`, as(meeting.key));
    const { key } = (await door.next('admitted')).d;
    expect(await door.closed).toBe(1000);

    const guest = await state(meeting.id, key);
    expect(guest.participants.map((p) => [p.name, p.userId, p.host])).toEqual([
      ['Anfitriã', host.user.id, true],
      ['Visita', null, false],
    ]);
    expect(guest.waiting).toEqual([]);
    // Anyone inside may let people in, not only the host.
    const second = await guestInside(meeting, 'Outra');
    expect((await state(meeting.id, second)).participants).toHaveLength(3);
  });

  it('turns people away, and forgets those who stop waiting', async () => {
    const host = await t.account('Anfitriã');
    const meeting = await create(host);
    const turnedAway = (await knock(meeting.id, { name: 'Não' })).json<MeetingKnockResponse>();
    const gaveUp = (await knock(meeting.id, { name: 'Desistiu' })).json<MeetingKnockResponse>();
    if (turnedAway.status !== 'waiting' || gaveUp.status !== 'waiting') throw new Error('wait');

    const door = await connect(meeting.id, { requestKey: turnedAway.requestKey });
    const leaving = await connect(meeting.id, { requestKey: gaveUp.requestKey });
    await eventually(async () =>
      expect((await state(meeting.id, meeting.key)).waiting).toHaveLength(2),
    );

    const requestId = turnedAway.requestKey.split('.')[0] ?? '';
    await t.request('POST', `/meetings/${meeting.id}/waiting/${requestId}/deny`, as(meeting.key));
    await door.next('denied');
    leaving.close();
    await eventually(async () =>
      expect((await state(meeting.id, meeting.key)).waiting).toEqual([]),
    );
    expect((await state(meeting.id, meeting.key)).participants).toHaveLength(1);
    // Answered once: a second answer finds nobody.
    const again = await t.request(
      'POST',
      `/meetings/${meeting.id}/waiting/${requestId}/admit`,
      as(meeting.key),
    );
    expect(again.statusCode).toBe(404);
  });

  it('lets a signed-in user knock under their own name, and the host straight in', async () => {
    const host = await t.account('Anfitriã');
    const friend = await t.account('Amigo');
    const meeting = await create(host);

    const asked = (await knock(meeting.id, { token: friend.token })).json<MeetingKnockResponse>();
    expect(asked.status).toBe('waiting');
    const waiting = (await state(meeting.id, meeting.key)).waiting;
    expect(waiting).toMatchObject([{ name: 'Amigo', hasAccount: true }]);

    // The host on another device.
    const back = (await knock(meeting.id, { token: host.token })).json<MeetingKnockResponse>();
    expect(back.status).toBe('admitted');
    // A guest has to give a name.
    expect((await knock(meeting.id, {})).statusCode).toBe(400);
  });

  it('keeps the chat for whoever is inside', async () => {
    const host = await t.account('Anfitriã');
    const meeting = await create(host);
    const guestKey = await guestInside(meeting);
    const hostSocket = await connect(meeting.id, { key: meeting.key });
    await hostSocket.next('state');

    const sent = await t.request('POST', `/meetings/${meeting.id}/messages`, {
      ...as(guestKey),
      body: { content: '  oi, gente  ' },
    });
    expect(sent.statusCode).toBe(201);
    expect((await hostSocket.next('message')).d).toMatchObject({
      name: 'Convidada',
      content: 'oi, gente',
    });
    expect((await state(meeting.id, meeting.key)).messages.map((m) => m.content)).toEqual([
      'oi, gente',
    ]);
    const outsider = await t.request('POST', `/meetings/${meeting.id}/messages`, {
      ...as('p123.wrong'),
      body: { content: 'olá' },
    });
    expect(outsider.statusCode).toBe(403);
  });

  it('hands out a voice token for the meeting room only to those inside', async () => {
    const host = await t.account('Anfitriã');
    const meeting = await create(host);
    const response = await t.request(
      'POST',
      `/meetings/${meeting.id}/voice-token`,
      as(meeting.key),
    );
    expect(response.statusCode).toBe(200);
    const token = response.json<{ token: string }>().token;
    const claims = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString(),
    ) as Record<string, unknown>;
    expect(claims).toMatchObject({ room: meetingRoom(meeting.id), speak: true, stream: true });
    expect(
      (await t.request('POST', `/meetings/${meeting.id}/voice-token`, as('nobody.secret')))
        .statusCode,
    ).toBe(403);
  });

  it('follows who is in the call from the media service', async () => {
    const host = await t.account('Anfitriã');
    const meeting = await create(host);
    const socket = await connect(meeting.id, { key: meeting.key });
    const selfId = (await socket.next('state')).d.selfId;

    media.emit(meetingRoom(meeting.id), selfId, {});
    await socket.next('state', (frame) => frame.d.participants[0]?.inCall === true);
    media.emit(meetingRoom(meeting.id), selfId, null);
    await socket.next('state', (frame) => frame.d.participants[0]?.inCall === false);
  });

  /** Reads the claims of a meeting voice token. */
  const tokenClaims = async (meetingId: string, key: string) => {
    const response = await t.request('POST', `/meetings/${meetingId}/voice-token`, as(key));
    const token = response.json<{ token: string }>().token;
    return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as {
      speak: boolean;
    };
  };

  it('lets the host mute someone for everyone, and give the microphone back', async () => {
    const host = await t.account('Anfitriã');
    const meeting = await create(host);
    const guestKey = await guestInside(meeting);
    const guestId = guestKey.split('.')[0] ?? '';
    const mute = (key: string, target: string, muted: boolean) =>
      t.request('PUT', `/meetings/${meeting.id}/participants/${target}/mute`, {
        ...as(key),
        body: { muted },
      });

    expect((await mute(meeting.key, guestId, true)).statusCode).toBe(204);
    // Dropped from the call to come back with a token that does not let them speak.
    expect(media.calls).toContainEqual({
      method: 'disconnectUser',
      data: { userId: guestId, roomId: meetingRoom(meeting.id), reason: 'permissions' },
    });
    expect((await tokenClaims(meeting.id, guestKey)).speak).toBe(false);
    const seen = (await state(meeting.id, guestKey)).participants.find((p) => p.id === guestId);
    expect(seen?.mutedByHost).toBe(true);

    expect((await mute(meeting.key, guestId, false)).statusCode).toBe(204);
    expect((await tokenClaims(meeting.id, guestKey)).speak).toBe(true);
  });

  it('gives guests no say over the host or each other', async () => {
    const host = await t.account('Anfitriã');
    const meeting = await create(host);
    const hostId = (await state(meeting.id, meeting.key)).selfId;
    const guestKey = await guestInside(meeting, 'Um');
    const otherKey = await guestInside(meeting, 'Outro');
    const otherId = otherKey.split('.')[0] ?? '';

    for (const target of [hostId, otherId]) {
      const muted = await t.request('PUT', `/meetings/${meeting.id}/participants/${target}/mute`, {
        ...as(guestKey),
        body: { muted: true },
      });
      expect(muted.statusCode).toBe(403);
      const removed = await t.request(
        'DELETE',
        `/meetings/${meeting.id}/participants/${target}`,
        as(guestKey),
      );
      expect(removed.statusCode).toBe(403);
    }
    // Not even the host can mute or remove the host.
    const self = await t.request(
      'DELETE',
      `/meetings/${meeting.id}/participants/${hostId}`,
      as(meeting.key),
    );
    expect(self.statusCode).toBe(403);
    expect(media.calls.filter((call) => call.method === 'disconnectUser')).toEqual([]);
    expect((await tokenClaims(meeting.id, meeting.key)).speak).toBe(true);
  });

  it('lets the host take someone out; their key stops working', async () => {
    const host = await t.account('Anfitriã');
    const meeting = await create(host);
    const guestKey = await guestInside(meeting);
    const guestId = guestKey.split('.')[0] ?? '';
    const guest = await connect(meeting.id, { key: guestKey });
    await guest.next('state');

    const removed = await t.request(
      'DELETE',
      `/meetings/${meeting.id}/participants/${guestId}`,
      as(meeting.key),
    );
    expect(removed.statusCode).toBe(204);
    expect((await guest.next('ended')).d.reason).toBe('removed');
    expect(media.calls).toContainEqual({
      method: 'disconnectUser',
      data: { userId: guestId, roomId: meetingRoom(meeting.id), reason: 'kicked' },
    });
    expect(
      (await t.request('POST', `/meetings/${meeting.id}/voice-token`, as(guestKey))).statusCode,
    ).toBe(403);
    expect((await state(meeting.id, meeting.key)).participants).toHaveLength(1);
  });

  it('ends for everyone when the host ends it, and everything in it goes', async () => {
    const host = await t.account('Anfitriã');
    const meeting = await create(host);
    const guestKey = await guestInside(meeting);
    const guest = await connect(meeting.id, { key: guestKey });
    await guest.next('state');

    expect((await t.request('POST', `/meetings/${meeting.id}/end`, as(guestKey))).statusCode).toBe(
      403,
    );
    expect(
      (await t.request('POST', `/meetings/${meeting.id}/end`, as(meeting.key))).statusCode,
    ).toBe(204);

    expect((await guest.next('ended')).d.reason).toBe('ended');
    expect(media.calls).toContainEqual({
      method: 'closeRoom',
      data: { roomId: meetingRoom(meeting.id) },
    });
    expect((await t.request('GET', `/meetings/${meeting.id}`)).statusCode).toBe(404);
    expect(await t.app.ctx.redis.keys(`meeting:${meeting.id}*`)).toEqual([]);
  });

  it('ends on its own once the call has been empty for the grace period', async () => {
    const host = await t.account('Anfitriã');
    const meeting = await create(host);
    const busy = await create(host);
    const { meetings } = t.app.ctx;
    const socket = await connect(busy.id, { key: busy.key });
    const selfId = (await socket.next('state')).d.selfId;
    media.emit(meetingRoom(busy.id), selfId, {});
    await socket.next('state', (frame) => frame.d.participants[0]?.inCall === true);

    const later = Date.now() + (MEETING_EMPTY_GRACE_SECONDS + 1) * 1000;
    await meetings.sweep(Date.now());
    expect((await t.request('GET', `/meetings/${meeting.id}`)).statusCode).toBe(200);
    await meetings.sweep(later);
    // Never joined: gone. In the call, however long: still there.
    expect((await t.request('GET', `/meetings/${meeting.id}`)).statusCode).toBe(404);
    expect((await t.request('GET', `/meetings/${busy.id}`)).statusCode).toBe(200);

    // Everyone leaves; the grace period counts from then.
    media.emit(meetingRoom(busy.id), selfId, null);
    await socket.next('state', (frame) => frame.d.participants[0]?.inCall === false);
    await meetings.sweep(Date.now() + 5000);
    expect((await t.request('GET', `/meetings/${busy.id}`)).statusCode).toBe(200);
    await meetings.sweep(Date.now() + (MEETING_EMPTY_GRACE_SECONDS + 1) * 1000);
    expect((await socket.next('ended')).d.reason).toBe('ended');
  });

  it('rebuilds who is in each call when the media link reopens', async () => {
    const host = await t.account('Anfitriã');
    const meeting = await create(host);
    const socket = await connect(meeting.id, { key: meeting.key });
    const selfId = (await socket.next('state')).d.selfId;

    media.peers = [
      {
        roomId: meetingRoom(meeting.id),
        userId: selfId,
        peerId: 'peer-x',
        state: { muted: false, deafened: false, streaming: false },
      },
    ];
    media.dropLinks();
    await socket.next('state', (frame) => frame.d.participants[0]?.inCall === true);
    media.peers = [];
  });

  it('closes a socket whose key is no good', async () => {
    const host = await t.account('Anfitriã');
    const meeting = await create(host);
    const stranger = await connect(meeting.id, { key: 'p1.nope' });
    expect((await stranger.next('ended')).d.reason).toBe('gone');
    expect(await stranger.closed).toBe(4404);
  });
});
