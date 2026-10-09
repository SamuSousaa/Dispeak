import { RpcPeer, type RpcSide } from '@frequencia/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from 'ws';

const HEARTBEAT_INTERVAL_MS = 30_000;

export interface SocketPeerOptions<L extends RpcSide, R extends RpcSide> {
  local: L;
  remote: R;
  log: FastifyBaseLogger;
  heartbeatIntervalMs?: number;
}

/**
 * Binds a WebSocket to an RpcPeer: text frames are fed to the peer, the peer is closed with
 * the socket, and dead connections are detected with ping/pong.
 */
export function createSocketPeer<L extends RpcSide, R extends RpcSide>(
  socket: WebSocket,
  options: SocketPeerOptions<L, R>,
): RpcPeer<L, R> {
  const peer = new RpcPeer({
    local: options.local,
    remote: options.remote,
    send: (frame) => {
      if (socket.readyState === socket.OPEN) socket.send(frame);
    },
    onError: (error, context) => options.log.debug({ err: error, context }, 'rpc protocol error'),
  });

  let alive = true;
  const heartbeat = setInterval(() => {
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);

  socket.on('pong', () => {
    alive = true;
  });
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      socket.close(1003, 'binary frames are not supported');
      return;
    }
    peer.receive(data.toString());
  });
  socket.on('close', () => {
    clearInterval(heartbeat);
    peer.close();
  });
  socket.on('error', (error) => options.log.debug({ err: error }, 'socket error'));

  return peer;
}
