import { randomUUID } from 'node:crypto';
import {
  P2P_ROOM_CAPACITY,
  P2pErrorCode,
  p2pClientSide,
  p2pServerSide,
  RpcError,
  type IceServer,
  type P2pPeer,
  type RpcPeer,
} from '@frequencia/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from 'ws';
import { createSocketPeer } from '../ws/rpc-socket';

interface Session {
  peer: P2pPeer;
  rpc: RpcPeer<typeof p2pServerSide, typeof p2pClientSide>;
}

export interface P2pSignalingOptions {
  /** ICE servers for a peer; TURN credentials are minted per peer. */
  iceServersFor: (peerId: string) => IceServer[];
  log: FastifyBaseLogger;
}

/**
 * Signaling for the lab 1:1 call. Rooms live in memory and hold at most two peers; the server
 * never looks inside SDP or ICE payloads, it only relays them to the other peer of the room.
 */
export class P2pSignaling {
  private readonly rooms = new Map<string, Map<string, Session>>();

  constructor(private readonly options: P2pSignalingOptions) {}

  get roomCount(): number {
    return this.rooms.size;
  }

  accept(socket: WebSocket): void {
    const { log, iceServersFor } = this.options;
    const rpc = createSocketPeer(socket, { local: p2pServerSide, remote: p2pClientSide, log });
    const id = randomUUID();
    let roomId: string | undefined;

    const leave = () => {
      if (!roomId) return;
      const room = this.rooms.get(roomId);
      roomId = undefined;
      if (!room?.delete(id)) return;
      for (const other of room.values()) other.rpc.notify('peer-left', { peerId: id });
      if (room.size === 0) {
        for (const [key, value] of this.rooms) if (value === room) this.rooms.delete(key);
      }
    };

    rpc.handle('join', ({ room: requestedRoom, nickname }) => {
      if (roomId) throw new RpcError(P2pErrorCode.AlreadyInRoom, 'already in a room');

      let room = this.rooms.get(requestedRoom);
      if (!room) {
        room = new Map();
        this.rooms.set(requestedRoom, room);
      }
      if (room.size >= P2P_ROOM_CAPACITY) {
        throw new RpcError(P2pErrorCode.RoomFull, 'the room is full');
      }

      const self: P2pPeer = { id, nickname };
      const peers = [...room.values()].map((session) => session.peer);
      for (const other of room.values()) other.rpc.notify('peer-joined', { peer: self });
      room.set(id, { peer: self, rpc });
      roomId = requestedRoom;

      return { self, peers, iceServers: iceServersFor(id) };
    });

    rpc.handle('leave', () => {
      if (!roomId) throw new RpcError(P2pErrorCode.NotInRoom, 'not in a room');
      leave();
      return {};
    });

    rpc.on('signal', ({ to, payload }) => {
      // Relays only reach peers of the sender's own room.
      const target = roomId ? this.rooms.get(roomId)?.get(to) : undefined;
      target?.rpc.notify('signal', { from: id, payload });
    });

    socket.on('close', leave);
  }
}
