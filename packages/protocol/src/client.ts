import { PROTOCOL_VERSION, SIG_AUTH, SIG_PAIR } from './version.js';
import { canonical } from './canonical.js';
import { normalizePairingCode } from './code.js';
import type { CryptoProvider, KeyPair } from './crypto.js';
import type {
  AdminOp,
  CallMsg,
  CallCancelMsg,
  ClientMessage,
  HelloMsg,
  ReadyMsg,
  ServerMessage,
} from './messages.js';
import type { Capability, CallRequest, Notification } from './types.js';

/**
 * The three things a client needs from its host platform. Supplying these is
 * the entire porting effort: the dashboard, the phone app and the CLI daemon
 * all run the identical handshake, reconnect and replay logic below.
 */
export interface ClientStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((this: unknown, ev: unknown) => unknown) | null;
  onmessage: ((this: unknown, ev: { data: unknown }) => unknown) | null;
  onclose: ((this: unknown, ev: unknown) => unknown) | null;
  onerror: ((this: unknown, ev: unknown) => unknown) | null;
}

export interface NotifyClientOptions {
  /** `ws://host:7741`. Use `wss://` whenever the hub is not on localhost. */
  url: string;
  crypto: CryptoProvider;
  storage: ClientStorage;
  createSocket(url: string): SocketLike;
  deviceName: string;
  platform: string;
  model?: string;
  /** Reconnect with exponential backoff after an unexpected close. */
  autoReconnect?: boolean;
  /** Namespaces stored credentials so one app can hold several identities. */
  storagePrefix?: string;
  /**
   * Whether this device currently has any network at all.
   *
   * Without it, a phone going through a tunnel looks exactly like a service
   * that has died, and the difference matters at 3am. When this returns false
   * the local watchdog holds its fire.
   */
  isOnline?(): boolean | Promise<boolean>;
}

/** What a device knows about the hub it is watching. */
export interface WatchdogSpec {
  enabled: boolean;
  intervalMs: number;
  graceMs: number;
  alert: { title: string; body?: string; severity: string };
}

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'unpaired'
  | 'pairing'
  | 'ready'
  | 'reconnecting'
  | 'revoked'
  | 'error';

export interface ClientEvents {
  status: ConnectionStatus;
  ready: ReadyMsg;
  notification: Notification;
  call: CallRequest;
  'call.cancel': { callId: string; reason: string };
  resolve: { ids: string[]; key?: string };
  /**
   * The hub has gone quiet for longer than it promised. `certain` is false
   * when this device could not confirm its own connectivity, in which case the
   * honest reading is "I cannot reach the service", not "the service is down".
   */
  'service:missing': {
    spec: WatchdogSpec;
    silentForMs: number;
    certain: boolean;
  };
  /** The hub is being heard from again. */
  'service:back': { downForMs: number };
  /** The hub said it was going away on purpose. */
  'service:bye': { reason: string; expectedDowntimeMs: number };
  paired: { deviceId: string; role: string };
  revoked: { reason: string };
  error: { code: string; message: string };
}

type Handler<K extends keyof ClientEvents> = (payload: ClientEvents[K]) => void;

/**
 * A device's side of the protocol.
 *
 * The keypair is generated locally on first pair and kept in platform storage;
 * from then on the client re-authenticates by signing the hub's per-connection
 * nonce, so nothing reusable is ever transmitted.
 */
export class NotifyClient {
  private socket: SocketLike | undefined;
  private hello: HelloMsg | undefined;
  private keys: KeyPair | undefined;
  private deviceId: string | undefined;
  private ackedSeq = 0;
  private backoff = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private closedByUs = false;
  private pendingCode: string | undefined;
  private adminSeq = 0;
  /**
   * Milliseconds this device's clock is behind the hub's.
   *
   * Auth signatures carry a timestamp the hub rejects outside a 60s window, so
   * a phone or VM with a drifted clock would otherwise fail authentication
   * forever with nothing to explain why. `hello` always arrives before we
   * sign, so the offset is known by the time it matters.
   */
  private clockOffset = 0;

  /* --- local watchdog: this device watching the hub ------------------- */
  private watchdogSpec: WatchdogSpec | undefined;
  private watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  private lastHeardAt = 0;
  private serviceMissing = false;
  /** Set by a `bye`; suppresses the alarm for a shutdown we were told about. */
  private expectedSilenceUntil = 0;
  private adminWaiters = new Map<string, { resolve(v: unknown): void; reject(e: Error): void }>();
  private listeners = new Map<string, Set<(payload: never) => void>>();

  status: ConnectionStatus = 'idle';
  role: string | undefined;
  capabilities: Capability[] = [];

  constructor(private readonly opts: NotifyClientOptions) {}

  private key(name: string): string {
    return `${this.opts.storagePrefix ?? 'notifyjs'}.${name}`;
  }

  on<K extends keyof ClientEvents>(event: K, handler: Handler<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as (payload: never) => void);
    return () => set!.delete(handler as (payload: never) => void);
  }

  private emit<K extends keyof ClientEvents>(event: K, payload: ClientEvents[K]): void {
    for (const handler of this.listeners.get(event) ?? []) {
      try {
        (handler as Handler<K>)(payload);
      } catch {
        // A throwing listener must not take down the socket loop.
      }
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  /** True once this device holds credentials, whether or not it is connected. */
  async isPaired(): Promise<boolean> {
    return (await this.opts.storage.get(this.key('deviceId'))) !== null;
  }

  async loadCredentials(): Promise<boolean> {
    const [deviceId, publicKey, secretSeed, seq] = await Promise.all([
      this.opts.storage.get(this.key('deviceId')),
      this.opts.storage.get(this.key('publicKey')),
      this.opts.storage.get(this.key('secretSeed')),
      this.opts.storage.get(this.key('ackedSeq')),
    ]);
    if (!deviceId || !publicKey || !secretSeed) return false;
    this.deviceId = deviceId;
    this.keys = { publicKey, secretSeed };
    this.ackedSeq = seq ? Number(seq) : 0;

    // The watchdog spec has to survive an app restart, or closing the app
    // would quietly disable the only thing watching the service.
    const stored = await this.opts.storage.get(this.key('watchdog'));
    if (stored) {
      try {
        this.watchdogSpec = JSON.parse(stored) as WatchdogSpec;
      } catch {
        /* a corrupt spec just means we wait for the hub to resend it */
      }
    }
    return true;
  }

  async forgetCredentials(): Promise<void> {
    this.deviceId = undefined;
    this.keys = undefined;
    this.ackedSeq = 0;
    // The watchdog contract goes with them. A revoked device that kept its
    // spec would keep raising "the service is down" about a hub it is no
    // longer entitled to hear from - and would leave the key behind in
    // storage for every source that is ever added and removed.
    this.watchdogSpec = undefined;
    this.disarmWatchdog();
    this.serviceMissing = false;
    await Promise.all([
      this.opts.storage.remove(this.key('deviceId')),
      this.opts.storage.remove(this.key('publicKey')),
      this.opts.storage.remove(this.key('secretSeed')),
      this.opts.storage.remove(this.key('ackedSeq')),
      this.opts.storage.remove(this.key('watchdog')),
    ]);
  }

  /** Opens the socket and authenticates, if this device is already paired. */
  async connect(): Promise<void> {
    this.closedByUs = false;
    await this.loadCredentials();
    this.open();
  }

  /**
   * Redeems a pairing code. The keypair is minted here and the private half
   * never leaves this device, so the code is the only secret in transit — and
   * it is single-use and expires in minutes.
   */
  async pair(code: string): Promise<void> {
    this.closedByUs = false;
    this.pendingCode = normalizePairingCode(code);
    if (!this.keys) this.keys = await this.opts.crypto.generateKeyPair();
    this.open();
  }

  disconnect(): void {
    this.closedByUs = true;
    // Deliberately leaving is not the service dying.
    this.disarmWatchdog();
    this.serviceMissing = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.close(1000, 'client closed');
    this.socket = undefined;
    this.setStatus('idle');
  }

  private open(): void {
    this.setStatus(this.backoff > 0 ? 'reconnecting' : 'connecting');
    const socket = this.opts.createSocket(this.opts.url);
    this.socket = socket;

    socket.onopen = () => {
      // Nothing to do: the hub speaks first with `hello`, and we cannot sign
      // anything until we have its nonce.
    };
    socket.onmessage = (ev) => {
      void this.receive(String(ev.data));
    };
    socket.onerror = () => {
      this.setStatus('error');
    };
    socket.onclose = () => {
      this.socket = undefined;
      // Anything still waiting on this socket will never be answered.
      this.failPendingAdmin('the connection closed before the hub replied');
      // A closed socket is a strong hint, but not proof: reconnecting may
      // succeed immediately. Let the same deadline decide, so a blip during a
      // restart does not page anyone.
      this.armWatchdog();
      if (this.closedByUs || this.status === 'revoked') return;
      // Reconnecting without credentials would reopen the socket, be told
      // "unpaired" again, and close - forever, at up to one attempt a second.
      // The UI has to supply a code before there is any point in retrying.
      if (this.status === 'unpaired') return;
      if (!this.opts.autoReconnect) {
        this.setStatus('idle');
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    this.setStatus('reconnecting');
    // Exponential up to 30s, with jitter so a hub restart does not bring every
    // device back in the same instant.
    this.backoff = Math.min(this.backoff === 0 ? 1000 : this.backoff * 2, 30_000);
    const delay = this.backoff * (0.5 + Math.random() / 2);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private send(msg: ClientMessage): void {
    try {
      this.socket?.send(JSON.stringify(msg));
    } catch {
      // Socket already closing; onclose will drive the reconnect.
    }
  }

  private async receive(raw: string): Promise<void> {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }

    // Any frame at all proves the hub is alive; `beat` merely guarantees there
    // is traffic to observe during quiet periods.
    this.noteHeardFrom();

    switch (msg.t) {
      case 'hello':
        this.hello = msg;
        this.clockOffset = msg.serverTime - Date.now();
        await this.handshake(msg);
        return;

      case 'paired':
        this.deviceId = msg.deviceId;
        this.role = msg.role;
        this.capabilities = msg.capabilities;
        await this.persistCredentials();
        this.pendingCode = undefined;
        this.emit('paired', { deviceId: msg.deviceId, role: msg.role });
        return;

      case 'ready':
        this.backoff = 0;
        this.role = msg.role;
        this.capabilities = msg.capabilities;
        this.setStatus('ready');
        this.emit('ready', msg);
        return;

      case 'notification': {
        const n = (msg as { n: Notification }).n;
        this.emit('notification', n);
        return;
      }

      case 'call':
        this.emit('call', (msg as CallMsg).c);
        return;

      case 'call.cancel': {
        const c = msg as CallCancelMsg;
        this.emit('call.cancel', { callId: c.callId, reason: c.reason });
        return;
      }

      case 'resolve': {
        const r = msg as { ids: string[]; key?: string };
        this.emit('resolve', { ids: r.ids, key: r.key });
        return;
      }

      case 'watchdog': {
        const spec = msg as unknown as WatchdogSpec & { t: string };
        this.watchdogSpec = {
          enabled: spec.enabled,
          intervalMs: spec.intervalMs,
          graceMs: spec.graceMs,
          alert: spec.alert,
        };
        await this.opts.storage.set(this.key('watchdog'), JSON.stringify(this.watchdogSpec));
        this.armWatchdog();
        return;
      }

      case 'beat':
        return;

      case 'bye': {
        const bye = msg as unknown as { reason: string; expectedDowntimeMs: number };
        // A deploy should not page anyone. Hold the alarm for as long as the
        // hub says it expects to be away, plus its own grace.
        const hold = bye.expectedDowntimeMs || (this.watchdogSpec?.intervalMs ?? 0) * 4;
        this.expectedSilenceUntil = Date.now() + hold + (this.watchdogSpec?.graceMs ?? 0);
        this.disarmWatchdog();
        this.emit('service:bye', {
          reason: bye.reason,
          expectedDowntimeMs: bye.expectedDowntimeMs,
        });
        return;
      }

      case 'revoked':
        this.setStatus('revoked');
        await this.forgetCredentials();
        this.emit('revoked', { reason: msg.reason });
        return;

      case 'admin.result': {
        const waiter = this.adminWaiters.get(msg.id);
        if (!waiter) return;
        this.adminWaiters.delete(msg.id);
        if (msg.ok) waiter.resolve(msg.data);
        else waiter.reject(new Error(msg.error ?? 'admin call failed'));
        return;
      }

      case 'error':
        this.emit('error', { code: msg.code, message: msg.message });
        if (msg.code === 'pair_failed' || msg.code === 'auth_failed') {
          this.setStatus('error');
        }
        return;

      default:
        return;
    }
  }

  private async handshake(hello: HelloMsg): Promise<void> {
    if (this.pendingCode && this.keys) {
      const transcript = canonical([
        SIG_PAIR,
        hello.serverId,
        hello.nonce,
        this.pendingCode,
        this.keys.publicKey,
        this.opts.deviceName,
        this.opts.platform,
      ]);
      this.send({
        v: PROTOCOL_VERSION,
        t: 'pair',
        code: this.pendingCode,
        publicKey: this.keys.publicKey,
        name: this.opts.deviceName,
        platform: this.opts.platform,
        model: this.opts.model,
        sig: await this.opts.crypto.sign(this.keys, transcript),
      });
      this.setStatus('pairing');
      return;
    }

    if (!this.deviceId || !this.keys) {
      // No credentials and no code: the UI needs to ask for one.
      this.setStatus('unpaired');
      this.socket?.close(1000, 'not paired');
      return;
    }

    const ts = this.now();
    const transcript = canonical([SIG_AUTH, hello.serverId, this.deviceId, hello.nonce, String(ts)]);
    this.send({
      v: PROTOCOL_VERSION,
      t: 'auth',
      deviceId: this.deviceId,
      ts,
      sig: await this.opts.crypto.sign(this.keys, transcript),
    });
  }

  private async persistCredentials(): Promise<void> {
    if (!this.deviceId || !this.keys) return;
    await Promise.all([
      this.opts.storage.set(this.key('deviceId'), this.deviceId),
      this.opts.storage.set(this.key('publicKey'), this.keys.publicKey),
      this.opts.storage.set(this.key('secretSeed'), this.keys.secretSeed),
    ]);
  }

  /* ----------------------------- actions ----------------------------- */

  /** Marks notifications as seen and advances the replay cursor. */
  ack(ids: string[], opts: { seq?: number; action?: string } = {}): void {
    if (opts.seq !== undefined && opts.seq > this.ackedSeq) {
      this.ackedSeq = opts.seq;
      void this.opts.storage.set(this.key('ackedSeq'), String(opts.seq));
    }
    this.send({ v: PROTOCOL_VERSION, t: 'ack', ids, seq: opts.seq, action: opts.action });
  }

  /** Asks the hub for anything missed, e.g. after the app was backgrounded. */
  sync(since = this.ackedSeq): void {
    this.send({ v: PROTOCOL_VERSION, t: 'sync', since });
  }

  answerCall(callId: string): void {
    this.send({ v: PROTOCOL_VERSION, t: 'call.reply', callId, outcome: 'answered' });
  }

  declineCall(callId: string): void {
    this.send({ v: PROTOCOL_VERSION, t: 'call.reply', callId, outcome: 'declined' });
  }

  /** Sent once the spoken message finishes, so the hub can close the record. */
  endCall(callId: string): void {
    this.send({ v: PROTOCOL_VERSION, t: 'call.ended', callId });
  }

  /** Issues a privileged operation; rejects if the role lacks the capability. */
  admin<T = unknown>(op: AdminOp, args?: Record<string, unknown>): Promise<T> {
    const id = `a${++this.adminSeq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.adminWaiters.delete(id)) reject(new Error(`admin ${op} timed out`));
      }, 10_000);
      (timer as { unref?: () => void }).unref?.();

      this.adminWaiters.set(id, {
        // Cancelling the timer on the way out keeps a busy dashboard from
        // holding thousands of pending timeouts it will never need.
        resolve: (v) => {
          clearTimeout(timer);
          (resolve as (v: unknown) => void)(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ v: PROTOCOL_VERSION, t: 'admin', id, op, args });
    });
  }

  /** Fails every outstanding admin call, e.g. because the socket went away. */
  private failPendingAdmin(reason: string): void {
    if (this.adminWaiters.size === 0) return;
    const waiters = [...this.adminWaiters.values()];
    this.adminWaiters.clear();
    for (const waiter of waiters) waiter.reject(new Error(reason));
  }

  /* ------------------------------------------------------------------ */
  /* Local watchdog: this device watching the hub                        */
  /* ------------------------------------------------------------------ */

  /** The spec this device is currently enforcing, if any. */
  get watchdog(): WatchdogSpec | undefined {
    return this.watchdogSpec;
  }

  /** True while this device believes it has lost the service. */
  get serviceLooksDown(): boolean {
    return this.serviceMissing;
  }

  private noteHeardFrom(): void {
    const wasMissing = this.serviceMissing;
    const silentFor = this.lastHeardAt ? Date.now() - this.lastHeardAt : 0;

    this.lastHeardAt = Date.now();
    this.expectedSilenceUntil = 0;

    if (wasMissing) {
      this.serviceMissing = false;
      this.emit('service:back', { downForMs: silentFor });
    }
    this.armWatchdog();
  }

  private armWatchdog(): void {
    this.disarmWatchdog();
    const spec = this.watchdogSpec;
    if (!spec?.enabled) return;

    const deadline = spec.intervalMs + spec.graceMs;
    this.watchdogTimer = setTimeout(() => void this.onSilence(), deadline);
    // Never let the watchdog be the reason a process stays alive.
    (this.watchdogTimer as { unref?: () => void }).unref?.();
  }

  private disarmWatchdog(): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = undefined;
  }

  /**
   * The hub has been quiet for longer than it promised.
   *
   * This is the one alert an embedded hub could never send for itself. It is
   * also the one most likely to be wrong, so before firing we check whether
   * this device has any network at all - a phone in a tunnel produces exactly
   * the same silence as a dead server.
   */
  private async onSilence(): Promise<void> {
    const spec = this.watchdogSpec;
    if (!spec?.enabled || this.serviceMissing) return;

    // A shutdown we were told about is not an incident.
    if (this.expectedSilenceUntil && Date.now() < this.expectedSilenceUntil) {
      this.armWatchdog();
      return;
    }

    let certain = true;
    if (this.opts.isOnline) {
      try {
        certain = await this.opts.isOnline();
      } catch {
        certain = false;
      }
    }

    if (!certain) {
      // We cannot tell the difference, so say nothing yet and look again.
      this.armWatchdog();
      return;
    }

    this.serviceMissing = true;
    this.emit('service:missing', {
      spec,
      silentForMs: Date.now() - this.lastHeardAt,
      certain,
    });
  }

  get serverName(): string | undefined {
    return this.hello?.serverName;
  }

  /** The hub's clock, as best this device can tell. */
  now(): number {
    return Date.now() + this.clockOffset;
  }

  /** How far this device's clock is off, for diagnostics. */
  get clockSkewMs(): number {
    return this.clockOffset;
  }

  /**
   * Registers a wake-up token so the hub can reach this device while the app
   * is closed. Opt-in: nothing is sent until the device calls this.
   */
  registerPush(token: string, provider: 'expo' = 'expo'): void {
    this.send({ v: PROTOCOL_VERSION, t: 'push.register', token, provider });
  }

  /** Withdraws the wake-up token. */
  unregisterPush(): void {
    this.send({ v: PROTOCOL_VERSION, t: 'push.register', token: '', provider: 'expo' });
  }

  /**
   * Silences this device for a while. Critical alerts still arrive, so this
   * quiets noise without turning the pager off.
   */
  snooze(durationMs: number): void {
    this.send({ v: PROTOCOL_VERSION, t: 'snooze', untilMs: this.now() + durationMs });
  }

  unsnooze(): void {
    this.send({ v: PROTOCOL_VERSION, t: 'snooze', untilMs: 0 });
  }
}

/** Storage backed by `localStorage`, for browsers. */
export function webStorage(): ClientStorage {
  return {
    async get(k) {
      return globalThis.localStorage?.getItem(k) ?? null;
    },
    async set(k, v) {
      globalThis.localStorage?.setItem(k, v);
    },
    async remove(k) {
      globalThis.localStorage?.removeItem(k);
    },
  };
}

/** Storage for tests and short-lived processes. */
export function memoryStorage(): ClientStorage {
  const map = new Map<string, string>();
  return {
    async get(k) {
      return map.get(k) ?? null;
    },
    async set(k, v) {
      map.set(k, v);
    },
    async remove(k) {
      map.delete(k);
    },
  };
}
