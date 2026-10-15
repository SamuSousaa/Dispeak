import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { hostAnswerSchema, hostEventSchema } from '@frequencia/shared';
import { app } from 'electron';
import type { z } from 'zod';
import { findBundled } from './bundled';

/** An answer that takes longer than this is given up on (the helper is restarted on demand). */
const TIMEOUT_MS = 8000;

type EventListener = (data: unknown) => void;

/**
 * The app's Windows helper (`dispeaker-host`, Rust): one process for the whole session,
 * started on the first request and again if it ever stops. Requests are answered in order of
 * arrival; every answer and event is checked against its schema before anyone sees it.
 */
class NativeHost {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly waiting = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly listeners = new Map<string, Set<EventListener>>();
  /** Watches to start again after a restart, by method. */
  private readonly watches = new Map<string, Record<string, unknown>>();

  /** Whether the helper ships with this app (it is missing from a build that skipped Rust). */
  readonly available =
    process.platform === 'win32' && findBundled('host', 'dispeaker-host.exe') !== null;

  private start(): ChildProcessWithoutNullStreams | null {
    if (this.child) return this.child;
    const program = findBundled('host', 'dispeaker-host.exe');
    if (!program) return null;
    const child = spawn(program, [], { windowsHide: true });
    this.child = child;
    let pending = '';
    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) this.onLine(line);
    });
    child.stderr.on('data', (chunk: Buffer) => console.warn(`[host] ${chunk.toString().trim()}`));
    const onGone = () => {
      if (this.child !== child) return;
      this.child = null;
      for (const [id, entry] of this.waiting) {
        clearTimeout(entry.timer);
        entry.reject(new Error('the helper stopped'));
        this.waiting.delete(id);
      }
      // A helper that died mid-watch comes back with its watches, unless the app is closing.
      if (this.watches.size > 0 && !quitting) setTimeout(() => this.restoreWatches(), 1000);
    };
    child.once('exit', onGone);
    child.once('error', onGone);
    return child;
  }

  private restoreWatches(): void {
    for (const [method, params] of this.watches)
      void this.call(method, params).catch(() => undefined);
  }

  private onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const event = hostEventSchema.safeParse(message);
    if (event.success) {
      for (const listener of this.listeners.get(event.data.event) ?? []) listener(event.data.data);
      return;
    }
    const answer = hostAnswerSchema.safeParse(message);
    if (!answer.success) return;
    const entry = this.waiting.get(answer.data.id);
    if (!entry) return;
    this.waiting.delete(answer.data.id);
    clearTimeout(entry.timer);
    if ('error' in answer.data) entry.reject(new Error(answer.data.error));
    else entry.resolve(answer.data.result);
  }

  private call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const child = this.start();
    if (!child) return Promise.reject(new Error('the helper is not installed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`the helper did not answer ${method}`));
      }, TIMEOUT_MS);
      this.waiting.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  /** Asks something and checks the answer. */
  async request<S extends z.ZodType>(
    method: string,
    params: Record<string, unknown>,
    schema: S,
  ): Promise<z.infer<S>> {
    return schema.parse(await this.call(method, params)) as z.infer<S>;
  }

  /**
   * Turns a watch on (`params`) or off (`null`); it outlives a restart of the helper. Events
   * reach `on` listeners.
   */
  async watch(method: string, params: Record<string, unknown> | null): Promise<void> {
    if (params) this.watches.set(method, params);
    else this.watches.delete(method);
    if (!params && !this.child) return;
    await this.call(method, params ?? { on: false });
  }

  /** Listens to one kind of event, each checked against `schema`. Returns how to stop. */
  on<S extends z.ZodType>(
    event: string,
    schema: S,
    listener: (data: z.infer<S>) => void,
  ): () => void {
    const wrapped: EventListener = (data) => {
      const parsed = schema.safeParse(data);
      if (parsed.success) listener(parsed.data as z.infer<S>);
    };
    const set = this.listeners.get(event) ?? new Set<EventListener>();
    set.add(wrapped);
    this.listeners.set(event, set);
    return () => set.delete(wrapped);
  }

  stop(): void {
    this.watches.clear();
    this.child?.stdin.end();
    this.child = null;
  }
}

let quitting = false;
app.on('before-quit', () => {
  quitting = true;
});

export const nativeHost = new NativeHost();
