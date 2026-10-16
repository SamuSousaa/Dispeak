import {
  API_PREFIX,
  GATEWAY_PATH,
  GatewayCloseCode,
  gatewayEvents,
  GatewayOp,
  gatewayServerFrameSchema,
  type GatewayEventName,
} from '@frequencia/shared';
import { wsUrl } from '../../lib/api';
import { getAccessToken, refreshSession, useAuthStore } from '../auth/auth-store';
import { applyGatewayEvent, initialGatewayState, useGatewayStore } from './gateway-store';

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15_000];

type Listener = (t: GatewayEventName, data: unknown) => void;

/**
 * Connection to the realtime gateway. It identifies with the access token, answers the
 * server's heartbeat schedule, and after a drop resumes the same session so no event is
 * missed (falling back to a fresh identify when the session is gone).
 */
class GatewayClient {
  private socket: WebSocket | null = null;
  private heartbeatTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private sessionId: string | null = null;
  private seq = 0;
  private acked = true;
  private attempt = 0;
  private running = false;
  private readonly listeners = new Set<Listener>();

  start(): void {
    if (this.running) return;
    this.running = true;
    useGatewayStore.setState({ status: 'connecting' });
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearTimers();
    this.sessionId = null;
    this.seq = 0;
    this.attempt = 0;
    this.socket?.close(1000);
    this.socket = null;
    useGatewayStore.setState(initialGatewayState);
  }

  /** What the user is doing (the game running), kept to tell every new session. */
  private activity: string | null = null;

  /** Shows the others what the user plays (`null`: nothing). Sent again after a reconnection. */
  setActivity(game: string | null): void {
    if (game === this.activity) return;
    this.activity = game;
    this.sendActivity();
  }

  private sendActivity(): void {
    if (this.sessionId) this.send({ op: GatewayOp.UpdateActivity, d: { game: this.activity } });
  }

  /** Observes every dispatch after it has been applied to the store. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private connect(): void {
    if (!this.running) return;
    const socket = new WebSocket(wsUrl(`${API_PREFIX}${GATEWAY_PATH}`));
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      if (this.socket === socket && typeof event.data === 'string') this.onFrame(event.data);
    });
    socket.addEventListener('close', (event) => {
      if (this.socket === socket) this.onClose(event.code);
    });
  }

  private send(frame: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  private onFrame(raw: string): void {
    const frame = gatewayServerFrameSchema.safeParse(JSON.parse(raw));
    if (!frame.success) return;

    switch (frame.data.op) {
      case GatewayOp.Hello: {
        const { heartbeatInterval } = frame.data.d as { heartbeatInterval: number };
        this.startHeartbeat(heartbeatInterval);
        void this.authenticate();
        break;
      }
      case GatewayOp.HeartbeatAck:
        this.acked = true;
        break;
      case GatewayOp.InvalidSession:
        // The session cannot be resumed: start a new one on this same connection.
        this.sessionId = null;
        this.seq = 0;
        void this.authenticate();
        break;
      case GatewayOp.Dispatch:
        this.onDispatch(frame.data.t, frame.data.s, frame.data.d);
        break;
    }
  }

  private onDispatch(t: string | undefined, s: number | undefined, d: unknown): void {
    if (s !== undefined) this.seq = s;
    if (!t || !(t in gatewayEvents)) return;
    const name = t as GatewayEventName;
    const data = gatewayEvents[name].safeParse(d);
    if (!data.success) {
      console.warn(`[gateway] invalid ${name} payload`, data.error);
      return;
    }
    if (name === 'READY') {
      this.sessionId = (data.data as { sessionId: string }).sessionId;
      // A new session starts with nothing to show: tell it what the user is doing.
      if (this.activity) this.sendActivity();
    }
    if (name === 'READY' || name === 'RESUMED') this.attempt = 0;
    applyGatewayEvent(name, data.data as never);
    for (const listener of this.listeners) listener(name, data.data);
  }

  private async authenticate(): Promise<void> {
    const token = await getAccessToken();
    if (!token) {
      this.stop();
      return;
    }
    if (this.sessionId) {
      this.send({
        op: GatewayOp.Resume,
        d: { token, sessionId: this.sessionId, seq: this.seq },
      });
    } else {
      this.send({ op: GatewayOp.Identify, d: { token } });
    }
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer);
    this.acked = true;
    this.heartbeatTimer = window.setInterval(() => {
      if (!this.acked) {
        // The previous beat was never acknowledged: the connection is a zombie.
        this.socket?.close(4000, 'heartbeat not acknowledged');
        return;
      }
      this.acked = false;
      this.send({ op: GatewayOp.Heartbeat, d: this.seq || null });
    }, intervalMs);
  }

  private onClose(code: number): void {
    this.socket = null;
    if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (!this.running) return;

    if (code === GatewayCloseCode.AuthenticationFailed) {
      // The access token was rejected: get a new one, or give up if the session is over.
      this.sessionId = null;
      void refreshSession().then((token) => {
        if (token) this.scheduleReconnect();
        else this.stop();
      });
      return;
    }
    if (code === GatewayCloseCode.SessionTimedOut) this.sessionId = null;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running || useAuthStore.getState().status !== 'authenticated') return;
    useGatewayStore.setState({ status: 'reconnecting' });
    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 15_000;
    this.attempt += 1;
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  private clearTimers(): void {
    if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
  }
}

export const gateway = new GatewayClient();
