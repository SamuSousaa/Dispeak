import type { z } from 'zod';
import { RpcError, RpcErrorCode, rpcFrameSchema, type RpcFrame } from './envelope';

export interface RpcRequestSpec {
  request: z.ZodType;
  response: z.ZodType;
}

/** Everything one side of a connection is able to receive. */
export interface RpcSide {
  requests: Record<string, RpcRequestSpec>;
  events: Record<string, z.ZodType>;
}

/** Identity helper that keeps the literal method/event names of a side definition. */
export function defineSide<const S extends RpcSide>(side: S): S {
  return side;
}

export const emptySide = defineSide({ requests: {}, events: {} });

type Methods<S extends RpcSide> = keyof S['requests'] & string;
type Events<S extends RpcSide> = keyof S['events'] & string;

export type RequestInput<S extends RpcSide, M extends Methods<S>> = z.input<
  S['requests'][M]['request']
>;
export type RequestData<S extends RpcSide, M extends Methods<S>> = z.infer<
  S['requests'][M]['request']
>;
export type ResponseInput<S extends RpcSide, M extends Methods<S>> = z.input<
  S['requests'][M]['response']
>;
export type ResponseData<S extends RpcSide, M extends Methods<S>> = z.infer<
  S['requests'][M]['response']
>;
export type EventInput<S extends RpcSide, E extends Events<S>> = z.input<S['events'][E]>;
export type EventData<S extends RpcSide, E extends Events<S>> = z.infer<S['events'][E]>;

export type RequestHandler<S extends RpcSide, M extends Methods<S>> = (
  data: RequestData<S, M>,
) => ResponseInput<S, M> | Promise<ResponseInput<S, M>>;

export interface RpcPeerOptions<L extends RpcSide, R extends RpcSide> {
  /** Requests and events this side accepts. */
  local: L;
  /** Requests and events the other side accepts. */
  remote: R;
  /** Writes one serialized frame to the transport. */
  send: (frame: string) => void;
  /** Milliseconds to wait for a response before rejecting with `timeout`. */
  requestTimeoutMs?: number;
  /** Called for frames that cannot be processed and for handler crashes. */
  onError?: (error: unknown, context: string) => void;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: RpcError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Transport-agnostic, schema-validated RPC endpoint. Both ends of a connection hold one:
 * feed incoming text frames to `receive()`, and it writes outgoing frames through `send`.
 */
export class RpcPeer<L extends RpcSide, R extends RpcSide> {
  private readonly handlers = new Map<string, (data: unknown) => unknown>();
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private nextId = 1;
  private isClosed = false;

  constructor(private readonly options: RpcPeerOptions<L, R>) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /** Registers the handler for a request this side accepts. */
  handle<M extends Methods<L>>(method: M, handler: RequestHandler<L, M>): this {
    this.handlers.set(method, handler as (data: unknown) => unknown);
    return this;
  }

  /** Subscribes to an event this side accepts. Returns the unsubscribe function. */
  on<E extends Events<L>>(event: E, listener: (data: EventData<L, E>) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const erased = listener as (data: unknown) => void;
    set.add(erased);
    return () => set.delete(erased);
  }

  /** Calls a request on the other side and resolves with its validated response. */
  request<M extends Methods<R>>(method: M, data: RequestInput<R, M>): Promise<ResponseData<R, M>> {
    if (this.isClosed) return Promise.reject(new RpcError(RpcErrorCode.Closed));
    const id = this.nextId++;
    return new Promise<ResponseData<R, M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(RpcErrorCode.Timeout, `request "${method}" timed out`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.write({ t: 'req', id, method, data });
    });
  }

  /** Emits a one-way event to the other side. */
  notify<E extends Events<R>>(event: E, data: EventInput<R, E>): void {
    if (this.isClosed) return;
    this.write({ t: 'evt', event, data });
  }

  /** Processes one raw frame coming from the transport. */
  receive(raw: string): void {
    if (this.isClosed) return;

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      this.options.onError?.(error, 'malformed frame');
      return;
    }
    const parsed = rpcFrameSchema.safeParse(json);
    if (!parsed.success) {
      this.options.onError?.(parsed.error, 'invalid frame');
      return;
    }

    const frame = parsed.data;
    switch (frame.t) {
      case 'req':
        void this.handleRequest(frame.id, frame.method, frame.data);
        break;
      case 'res':
        this.handleResponse(frame);
        break;
      case 'evt':
        this.handleEvent(frame.event, frame.data);
        break;
    }
  }

  /** Rejects every in-flight request. Call when the transport goes away. */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new RpcError(RpcErrorCode.Closed, `connection closed during "${pending.method}"`),
      );
    }
    this.pending.clear();
    this.handlers.clear();
    this.listeners.clear();
  }

  private async handleRequest(id: number, method: string, data: unknown): Promise<void> {
    const spec = this.options.local.requests[method];
    const handler = this.handlers.get(method);
    if (!spec || !handler) {
      this.fail(id, RpcErrorCode.UnknownMethod, `unknown method "${method}"`);
      return;
    }
    const input = spec.request.safeParse(data);
    if (!input.success) {
      this.fail(id, RpcErrorCode.InvalidPayload, `invalid payload for "${method}"`);
      return;
    }
    try {
      const result = await handler(input.data);
      this.write({ t: 'res', id, ok: true, data: result });
    } catch (error) {
      if (error instanceof RpcError) {
        this.fail(id, error.code, error.message);
      } else {
        this.options.onError?.(error, `handler "${method}"`);
        this.fail(id, RpcErrorCode.Internal, 'internal error');
      }
    }
  }

  private handleResponse(frame: Extract<RpcFrame, { t: 'res' }>): void {
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);

    if (!frame.ok) {
      pending.reject(new RpcError(frame.error.code, frame.error.message));
      return;
    }
    const spec = this.options.remote.requests[pending.method];
    const output = spec?.response.safeParse(frame.data);
    if (!output?.success) {
      pending.reject(
        new RpcError(RpcErrorCode.InvalidResponse, `invalid response for "${pending.method}"`),
      );
      return;
    }
    pending.resolve(output.data);
  }

  private handleEvent(event: string, data: unknown): void {
    const schema = this.options.local.events[event];
    if (!schema) {
      this.options.onError?.(new Error(`unknown event "${event}"`), 'event');
      return;
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      this.options.onError?.(parsed.error, `event "${event}"`);
      return;
    }
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      try {
        listener(parsed.data);
      } catch (error) {
        this.options.onError?.(error, `listener "${event}"`);
      }
    }
  }

  private fail(id: number, code: string, message: string): void {
    this.write({ t: 'res', id, ok: false, error: { code, message } });
  }

  private write(frame: RpcFrame): void {
    if (this.isClosed) return;
    try {
      this.options.send(JSON.stringify(frame));
    } catch (error) {
      this.options.onError?.(error, 'send');
    }
  }
}
