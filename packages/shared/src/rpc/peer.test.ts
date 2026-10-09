import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { RpcError, RpcErrorCode } from './envelope';
import { defineSide, emptySide, RpcPeer } from './peer';

const serverSide = defineSide({
  requests: {
    add: {
      request: z.object({ a: z.number(), b: z.number() }),
      response: z.object({ sum: z.number() }),
    },
    fail: { request: z.object({}), response: z.object({}) },
    crash: { request: z.object({}), response: z.object({}) },
    slow: { request: z.object({}), response: z.object({}) },
    lie: { request: z.object({}), response: z.object({ value: z.string() }) },
  },
  events: { ping: z.object({ n: z.number() }) },
});

const clientSide = defineSide({
  requests: {},
  events: { tick: z.object({ at: z.number() }) },
});

function pair(options: { timeoutMs?: number } = {}) {
  const errors: string[] = [];
  const server: RpcPeer<typeof serverSide, typeof clientSide> = new RpcPeer({
    local: serverSide,
    remote: clientSide,
    send: (frame) => queueMicrotask(() => client.receive(frame)),
    onError: (_error, context) => errors.push(`server:${context}`),
  });
  const client: RpcPeer<typeof clientSide, typeof serverSide> = new RpcPeer({
    local: clientSide,
    remote: serverSide,
    send: (frame) => queueMicrotask(() => server.receive(frame)),
    requestTimeoutMs: options.timeoutMs,
    onError: (_error, context) => errors.push(`client:${context}`),
  });
  return { server, client, errors };
}

describe('RpcPeer', () => {
  it('resolves a request with the validated response', async () => {
    const { server, client } = pair();
    server.handle('add', ({ a, b }) => ({ sum: a + b }));
    await expect(client.request('add', { a: 2, b: 3 })).resolves.toEqual({ sum: 5 });
  });

  it('matches concurrent responses by id', async () => {
    const { server, client } = pair();
    server.handle('add', async ({ a, b }) => {
      await new Promise((resolve) => setTimeout(resolve, a));
      return { sum: a + b };
    });
    const [slow, fast] = await Promise.all([
      client.request('add', { a: 30, b: 1 }),
      client.request('add', { a: 1, b: 1 }),
    ]);
    expect(slow.sum).toBe(31);
    expect(fast.sum).toBe(2);
  });

  it('rejects an invalid payload without calling the handler', async () => {
    const { server, client } = pair();
    const handler = vi.fn(() => ({ sum: 0 }));
    server.handle('add', handler);
    await expect(
      client.request('add', { a: 'x', b: 1 } as unknown as { a: number; b: number }),
    ).rejects.toMatchObject({ code: RpcErrorCode.InvalidPayload });
    expect(handler).not.toHaveBeenCalled();
  });

  it('propagates RpcError codes thrown by handlers', async () => {
    const { server, client } = pair();
    server.handle('fail', () => {
      throw new RpcError('room_full', 'the room is full');
    });
    await expect(client.request('fail', {})).rejects.toMatchObject({
      code: 'room_full',
      message: 'the room is full',
    });
  });

  it('hides unexpected handler errors behind internal_error', async () => {
    const { server, client, errors } = pair();
    server.handle('crash', () => {
      throw new Error('secret detail');
    });
    await expect(client.request('crash', {})).rejects.toMatchObject({
      code: RpcErrorCode.Internal,
      message: 'internal error',
    });
    expect(errors).toContain('server:handler "crash"');
  });

  it('answers unknown_method when no handler is registered', async () => {
    const { client } = pair();
    await expect(client.request('fail', {})).rejects.toMatchObject({
      code: RpcErrorCode.UnknownMethod,
    });
  });

  it('rejects a response that does not match the schema', async () => {
    const { server, client } = pair();
    server.handle('lie', () => ({ value: 42 }) as unknown as { value: string });
    await expect(client.request('lie', {})).rejects.toMatchObject({
      code: RpcErrorCode.InvalidResponse,
    });
  });

  it('times out when no response arrives', async () => {
    const { server, client } = pair({ timeoutMs: 20 });
    server.handle('slow', () => new Promise(() => undefined));
    await expect(client.request('slow', {})).rejects.toMatchObject({ code: RpcErrorCode.Timeout });
  });

  it('rejects in-flight requests when closed', async () => {
    const { server, client } = pair();
    server.handle('slow', () => new Promise(() => undefined));
    const request = client.request('slow', {});
    client.close();
    await expect(request).rejects.toMatchObject({ code: RpcErrorCode.Closed });
    await expect(client.request('slow', {})).rejects.toMatchObject({ code: RpcErrorCode.Closed });
  });

  it('delivers validated events in both directions', async () => {
    const { server, client } = pair();
    const onPing = vi.fn();
    const onTick = vi.fn();
    server.on('ping', onPing);
    const off = client.on('tick', onTick);

    client.notify('ping', { n: 1 });
    server.notify('tick', { at: 7 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(onPing).toHaveBeenCalledWith({ n: 1 });
    expect(onTick).toHaveBeenCalledWith({ at: 7 });

    off();
    server.notify('tick', { at: 8 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(onTick).toHaveBeenCalledTimes(1);
  });

  it('drops malformed frames and invalid events', async () => {
    const onError = vi.fn();
    const peer = new RpcPeer({
      local: serverSide,
      remote: emptySide,
      send: () => undefined,
      onError,
    });
    const onPing = vi.fn();
    peer.on('ping', onPing);

    peer.receive('not json');
    peer.receive(JSON.stringify({ t: 'nope' }));
    peer.receive(JSON.stringify({ t: 'evt', event: 'ping', data: { n: 'x' } }));
    peer.receive(JSON.stringify({ t: 'evt', event: 'unknown' }));

    expect(onPing).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(4);
  });
});
