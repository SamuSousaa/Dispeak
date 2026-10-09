import {
  API_PREFIX,
  P2P_SIGNALING_PATH,
  P2pErrorCode,
  p2pClientSide,
  p2pServerSide,
  RpcErrorCode,
} from '@frequencia/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers/app';
import { connectTestClient, type TestClient } from './helpers/rpc-client';

type Client = TestClient<typeof p2pClientSide, typeof p2pServerSide>;

describe('P2P signaling server', () => {
  let t: TestApp;
  let url: string;
  const clients: Client[] = [];

  const connect = async (): Promise<Client> => {
    const client = await connectTestClient(url, { local: p2pClientSide, remote: p2pServerSide });
    clients.push(client);
    return client;
  };

  beforeAll(async () => {
    t = await createTestApp({ STUN_URLS: 'stun:stun.example.org:3478' });
    url = `${t.wsUrl}${API_PREFIX}${P2P_SIGNALING_PATH}`;
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  afterAll(async () => {
    await t.close();
  });

  it('joins an empty room and receives the ICE configuration', async () => {
    const alice = await connect();
    const joined = await alice.rpc.request('join', { room: 'room-a', nickname: 'Alice' });

    expect(joined.self.nickname).toBe('Alice');
    expect(joined.peers).toEqual([]);
    expect(joined.iceServers).toEqual([{ urls: ['stun:stun.example.org:3478'] }]);
  });

  it('introduces the two peers of a room to each other', async () => {
    const alice = await connect();
    const bob = await connect();
    const aliceJoined = await alice.rpc.request('join', { room: 'room-b', nickname: 'Alice' });

    const peerJoined = alice.next('peer-joined');
    const bobJoined = await bob.rpc.request('join', { room: 'room-b', nickname: 'Bob' });

    expect(bobJoined.peers).toEqual([aliceJoined.self]);
    await expect(peerJoined).resolves.toEqual({ peer: bobJoined.self });
  });

  it('relays offer, answer and ICE candidates between the two peers', async () => {
    const alice = await connect();
    const bob = await connect();
    const a = await alice.rpc.request('join', { room: 'room-c', nickname: 'Alice' });
    const b = await bob.rpc.request('join', { room: 'room-c', nickname: 'Bob' });

    const offer = {
      type: 'description',
      description: { type: 'offer', sdp: 'v=0 offer' },
    } as const;
    const offerReceived = alice.next('signal');
    bob.rpc.notify('signal', { to: a.self.id, payload: offer });
    await expect(offerReceived).resolves.toEqual({ from: b.self.id, payload: offer });

    const answer = {
      type: 'description',
      description: { type: 'answer', sdp: 'v=0 answer' },
    } as const;
    const answerReceived = bob.next('signal');
    alice.rpc.notify('signal', { to: b.self.id, payload: answer });
    await expect(answerReceived).resolves.toEqual({ from: a.self.id, payload: answer });

    const candidate = {
      type: 'candidate',
      candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 9 typ host', sdpMid: '0' },
    } as const;
    const candidateReceived = bob.next('signal');
    alice.rpc.notify('signal', { to: b.self.id, payload: candidate });
    await expect(candidateReceived).resolves.toEqual({ from: a.self.id, payload: candidate });
  });

  it('rejects a third peer', async () => {
    const [alice, bob, carol] = await Promise.all([connect(), connect(), connect()]);
    await alice.rpc.request('join', { room: 'room-d', nickname: 'Alice' });
    await bob.rpc.request('join', { room: 'room-d', nickname: 'Bob' });

    await expect(
      carol.rpc.request('join', { room: 'room-d', nickname: 'Carol' }),
    ).rejects.toMatchObject({ code: P2pErrorCode.RoomFull });
  });

  it('does not relay signals across rooms', async () => {
    const alice = await connect();
    const mallory = await connect();
    const a = await alice.rpc.request('join', { room: 'room-e', nickname: 'Alice' });
    await mallory.rpc.request('join', { room: 'room-f', nickname: 'Mallory' });

    let received = false;
    alice.rpc.on('signal', () => {
      received = true;
    });
    mallory.rpc.notify('signal', {
      to: a.self.id,
      payload: { type: 'candidate', candidate: null },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toBe(false);
  });

  it('validates payloads against the shared schemas', async () => {
    const alice = await connect();
    await expect(
      alice.rpc.request('join', { room: 'not a valid room!', nickname: 'Alice' }),
    ).rejects.toMatchObject({ code: RpcErrorCode.InvalidPayload });
    await expect(alice.rpc.request('leave', {})).rejects.toMatchObject({
      code: P2pErrorCode.NotInRoom,
    });
  });

  it('notifies the remaining peer on leave and on disconnect, freeing the room', async () => {
    const alice = await connect();
    const bob = await connect();
    await alice.rpc.request('join', { room: 'room-g', nickname: 'Alice' });
    const b = await bob.rpc.request('join', { room: 'room-g', nickname: 'Bob' });

    const left = alice.next('peer-left');
    await bob.rpc.request('leave', {});
    await expect(left).resolves.toEqual({ peerId: b.self.id });

    // The slot is free again, and a dropped connection counts as leaving.
    const carol = await connect();
    const c = await carol.rpc.request('join', { room: 'room-g', nickname: 'Carol' });
    const dropped = alice.next('peer-left');
    carol.socket.terminate();
    await expect(dropped).resolves.toEqual({ peerId: c.self.id });
  });
});
