import { RpcPeer, type RpcSide } from '@frequencia/shared';
import WebSocket from 'ws';

export interface TestClient<L extends RpcSide, R extends RpcSide> {
  rpc: RpcPeer<L, R>;
  socket: WebSocket;
  /** Resolves with the next occurrence of an event. */
  next: <E extends keyof L['events'] & string>(event: E) => Promise<unknown>;
  close: () => Promise<void>;
}

/** Opens a real WebSocket and speaks the RPC protocol over it, like a browser would. */
export async function connectTestClient<L extends RpcSide, R extends RpcSide>(
  url: string,
  sides: { local: L; remote: R },
): Promise<TestClient<L, R>> {
  const socket = new WebSocket(url);
  const rpc = new RpcPeer({
    ...sides,
    send: (frame) => socket.send(frame),
    requestTimeoutMs: 2000,
  });
  socket.on('message', (data) => rpc.receive(data.toString()));
  socket.on('close', () => rpc.close());

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });

  return {
    rpc,
    socket,
    next: (event) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), 2000);
        const off = rpc.on(event, (data) => {
          clearTimeout(timer);
          off();
          resolve(data);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) return resolve();
        socket.once('close', () => resolve());
        socket.close();
      }),
  };
}
