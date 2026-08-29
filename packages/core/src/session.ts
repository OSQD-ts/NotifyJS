import type { WebSocket } from 'ws';
import type { Capability, Device, Role, ServerMessage } from '@osqd/notifyjs-protocol';
import { PROTOCOL_VERSION } from '@osqd/notifyjs-protocol';
import { MessageLimiter } from './guard.js';

export type SessionState = 'handshake' | 'ready' | 'closed';

/**
 * One connected socket. A session starts in `handshake` holding nothing but a
 * nonce, and only gains a device identity by proving a signature over it.
 */
export class Session {
  readonly id: string;
  state: SessionState = 'handshake';
  device: Device | undefined;
  role: Role | undefined;
  /** Single-use challenge. Cleared the moment it is spent. */
  nonce: string | undefined;
  readonly limiter: MessageLimiter;
  handshakeTimer: NodeJS.Timeout | undefined;
  /** Notifications sent but not yet acknowledged, for `requireAck` retries. */
  readonly pending = new Set<string>();
  /** Set once the peer has been dropped for refusing to drain its socket. */
  stalled = false;

  constructor(
    id: string,
    readonly ws: WebSocket,
    readonly ip: string,
    readonly origin: string | undefined,
    rate: { points: number; windowMs: number },
    private readonly maxBufferedBytes = 1024 * 1024,
  ) {
    this.id = id;
    this.limiter = new MessageLimiter(rate.points, rate.windowMs);
  }

  get deviceId(): string | undefined {
    return this.device?.id;
  }

  get deviceName(): string {
    return this.device?.name ?? 'unknown';
  }

  get capabilities(): Capability[] {
    return this.role?.capabilities ?? [];
  }

  /**
   * Sends a frame, unless the peer has stopped draining its socket.
   *
   * Every other defence in this project runs before authentication. This one
   * runs after: a device that authenticates and then simply never reads would
   * otherwise make the hub buffer without limit, since TCP backpressure has
   * nowhere to go once `ws` has accepted the write. Past the threshold the
   * session is dropped, which is safe - the device re-syncs from its ack
   * cursor when it reconnects, so nothing is actually lost.
   */
  send(msg: ServerMessage): void {
    if (this.ws.readyState !== 1 || this.stalled) return;

    if (this.ws.bufferedAmount > this.maxBufferedBytes) {
      this.stalled = true;
      this.destroy();
      return;
    }

    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      // A send failing means the socket is already gone; the close handler
      // will clean the session up. Nothing useful to do here.
    }
  }

  error(code: string, message: string, retryAfter?: number): void {
    const msg: ServerMessage = { v: PROTOCOL_VERSION, t: 'error', code, message };
    if (retryAfter !== undefined) msg.retryAfter = retryAfter;
    this.send(msg);
  }

  /** Spends the challenge. Returns undefined if it was already used. */
  takeNonce(): string | undefined {
    const n = this.nonce;
    this.nonce = undefined;
    return n;
  }

  clearHandshakeTimer(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
  }

  close(code = 1000, reason = 'closed'): void {
    this.clearHandshakeTimer();
    this.state = 'closed';
    try {
      this.ws.close(code, reason);
    } catch {
      /* already closing */
    }
  }

  /** Drops the socket without a clean handshake, for abuse cases. */
  destroy(): void {
    this.clearHandshakeTimer();
    this.state = 'closed';
    try {
      this.ws.terminate();
    } catch {
      /* already gone */
    }
  }
}
