import { RpcPeer, type RpcSide } from '@frequencia/shared';
import { wsUrl } from './api';

export interface RpcConnection<L extends RpcSide, R extends RpcSide> {
  rpc: RpcPeer<L, R>;
  socket: WebSocket;
  /** Closes the socket without triggering `onClose`. */
  close: () => void;
}

export interface ConnectRpcOptions<L extends RpcSide, R extends RpcSide> {
  /** Same-origin path, e.g. `/api/lab/p2p`. */
  path: string;
  local: L;
  remote: R;
  /** Called when the socket closes for any reason other than `close()`. */
  onClose?: (event: CloseEvent) => void;
  connectTimeoutMs?: number;
}

/** Opens a WebSocket and resolves, once it is open, with an RpcPeer bound to it. */
export function connectRpc<L extends RpcSide, R extends RpcSide>(
  options: ConnectRpcOptions<L, R>,
): Promise<RpcConnection<L, R>> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl(options.path));
    let opened = false;
    let closedByUs = false;

    const rpc = new RpcPeer({
      local: options.local,
      remote: options.remote,
      send: (frame) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(frame);
      },
      onError: (error, context) => console.warn(`[rpc] ${context}`, error),
    });

    const timeout = window.setTimeout(() => {
      if (opened) return;
      closedByUs = true;
      socket.close();
      reject(new Error('connection timed out'));
    }, options.connectTimeoutMs ?? 8000);

    socket.addEventListener('open', () => {
      opened = true;
      window.clearTimeout(timeout);
      resolve({
        rpc,
        socket,
        close: () => {
          closedByUs = true;
          rpc.close();
          socket.close();
        },
      });
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') rpc.receive(event.data);
    });
    socket.addEventListener('close', (event) => {
      window.clearTimeout(timeout);
      rpc.close();
      if (!opened) {
        reject(new Error('connection failed'));
      } else if (!closedByUs) {
        options.onClose?.(event);
      }
    });
  });
}
