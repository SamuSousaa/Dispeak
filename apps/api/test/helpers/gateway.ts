import {
  API_PREFIX,
  GATEWAY_PATH,
  GatewayOp,
  type GatewayEventData,
  type GatewayEventName,
} from '@frequencia/shared';
import WebSocket from 'ws';

interface Dispatch {
  s: number;
  t: GatewayEventName;
  d: unknown;
}

export interface GatewayClient {
  socket: WebSocket;
  /** Every dispatch received so far, in order. */
  dispatches: Dispatch[];
  /** Non-dispatch frames (hello, heartbeat ack, invalid session). */
  control: Array<{ op: number; d?: unknown }>;
  /** Last sequence number received. */
  seq: () => number;
  send: (frame: object) => void;
  identify: (token: string) => Promise<GatewayEventData<'READY'>>;
  resume: (token: string, sessionId: string, seq: number) => void;
  heartbeat: () => void;
  /** Resolves with the next unread dispatch of that type (optionally matching a predicate). */
  next: <T extends GatewayEventName>(
    t: T,
    predicate?: (data: GatewayEventData<T>) => boolean,
    timeoutMs?: number,
  ) => Promise<GatewayEventData<T>>;
  /** Resolves with the next control frame carrying that opcode. */
  nextControl: (op: number) => Promise<{ op: number; d?: unknown }>;
  /** Asserts that no dispatch of that type arrives for a while. */
  expectNone: (t: GatewayEventName, waitMs?: number) => Promise<void>;
  closed: Promise<number>;
  close: () => Promise<void>;
  /** Drops the TCP connection without a close handshake. */
  drop: () => Promise<void>;
}

export async function connectGateway(wsUrl: string): Promise<GatewayClient> {
  const socket = new WebSocket(`${wsUrl}${API_PREFIX}${GATEWAY_PATH}`);
  const dispatches: Dispatch[] = [];
  const control: GatewayClient['control'] = [];
  const read = new Set<Dispatch>();
  const readControl = new Set<object>();
  const waiters = new Set<() => void>();
  let lastSeq = 0;

  socket.on('message', (data) => {
    const frame = JSON.parse(data.toString()) as {
      op: number;
      s?: number;
      t?: string;
      d?: unknown;
    };
    if (frame.op === GatewayOp.Dispatch) {
      lastSeq = frame.s ?? lastSeq;
      dispatches.push({ s: frame.s ?? 0, t: frame.t as GatewayEventName, d: frame.d });
    } else {
      control.push({ op: frame.op, d: frame.d });
    }
    for (const wake of [...waiters]) wake();
  });

  const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });

  function waitFor<T>(find: () => T | undefined, what: string, timeoutMs = 4000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const check = () => {
        const found = find();
        if (found === undefined) return false;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(found);
        return true;
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`timed out waiting for ${what}`));
      }, timeoutMs);
      if (!check()) waiters.add(check);
    });
  }

  const client: GatewayClient = {
    socket,
    dispatches,
    control,
    seq: () => lastSeq,
    send: (frame) => socket.send(JSON.stringify(frame)),
    identify: (token) => {
      client.send({ op: GatewayOp.Identify, d: { token } });
      return client.next('READY');
    },
    resume: (token, sessionId, seq) => {
      client.send({ op: GatewayOp.Resume, d: { token, sessionId, seq } });
    },
    heartbeat: () => client.send({ op: GatewayOp.Heartbeat, d: lastSeq || null }),
    next: <T extends GatewayEventName>(
      t: T,
      predicate?: (data: GatewayEventData<T>) => boolean,
      timeoutMs?: number,
    ) =>
      waitFor<GatewayEventData<T>>(
        () => {
          const found = dispatches.find(
            (entry) =>
              entry.t === t &&
              !read.has(entry) &&
              (predicate?.(entry.d as GatewayEventData<T>) ?? true),
          );
          if (!found) return undefined;
          read.add(found);
          return found.d as GatewayEventData<T>;
        },
        `dispatch ${t}`,
        timeoutMs,
      ),
    nextControl: (op) =>
      waitFor(() => {
        const found = control.find((entry) => entry.op === op && !readControl.has(entry));
        if (found) readControl.add(found);
        return found;
      }, `control frame ${op}`),
    expectNone: async (t, waitMs = 250) => {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      const found = dispatches.find((entry) => entry.t === t && !read.has(entry));
      if (found) throw new Error(`unexpected ${t}: ${JSON.stringify(found.d)}`);
    },
    closed,
    close: async () => {
      if (socket.readyState !== WebSocket.CLOSED) socket.close();
      await closed;
    },
    drop: async () => {
      socket.terminate();
      await closed;
    },
  };
  return client;
}
