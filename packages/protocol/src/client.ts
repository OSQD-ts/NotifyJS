import { PROTOCOL_VERSION, SIG_AUTH, SIG_PAIR } from './version.js';
import { canonical } from './canonical.js';
import { normalizePairingCode } from './code.js';
import type { CryptoProvider, KeyPair } from './crypto.js';
import type {
  AdminOp,
  AdminResult,
  CallMsg,
  CallCancelMsg,
  ClientMessage,
  HelloMsg,
  ReadyMsg,
  ServerMessage,
} from './messages.js';
import type { Capability, CallRequest, Notification, WebPushKeys } from './types.js';

/**
 * How often a client sends `ping` when the hub does not say, and the unit the
 * silence deadline is counted in.
 */
const DEFAULT_KEEPALIVE_MS = 30_000;

/**
 * Missed keepalives tolerated before the connection is treated as dead.
 *
 * Two and a half rather than one: a single lost frame on a phone changing
 * cells is ordinary, and a reconnect costs a handshake and a replay.
 */
const KEEPALIVE_MISSES = 2.5;

/**
 * How long a socket has to open and finish its handshake before it is retried.
 *
 * Comfortably above the hub's own handshake timeout, so a slow but working
 * connection is never given up on first.
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;

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
  /**
   * How this device asks to be listed on the hub.
   *
   * A function is read when a name is actually needed, which is what a host
   * whose name can change while the client lives has to pass: the dashboard
   * builds its client when the page loads, long before anybody types a name into
   * the pairing form, so a captured string meant the hub recorded every browser
   * as `Browser` however carefully it had been named.
   */
  deviceName: string | (() => string);
  platform: string;
  model?: string;
  /** Reconnect with exponential backoff after an unexpected close. */
  autoReconnect?: boolean;
  /** Namespaces stored credentials so one app can hold several identities. */
  storagePrefix?: string;
  /**
   * How long to wait for a socket to open and finish its handshake, in
   * milliseconds, before dropping it and retrying. Defaults to 20 seconds.
   */
  connectTimeoutMs?: number;
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
  /**
   * Whether this connection is the one that enrolled the device.
   *
   * Only that connection may move the replay cursor to the hub's head, so a
   * device with a real backlog is never skipped past it.
   */
  private freshlyPaired = false;
  /** The hub this device paired with, if it has been stored. */
  private pairedWith: string | undefined;
  private backoff = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private closedByUs = false;
  private pendingCode: string | undefined;
  /**
   * The hub refused this device's pair or auth frame on the current socket.
   *
   * Retrying on a timer cannot help: the hub gives the same answer, and each
   * attempt is charged to this IP. A device revoked while offline banned its
   * own address within half a minute - and with it every device sharing that
   * NAT, for a ban that doubled on every cycle. Retries wait for somebody or
   * something to ask: `connect()`, `pair()` or `resume()`.
   */
  private rejected = false;
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

  /* --- application-level keepalive ----------------------------------- */
  /**
   * How often this client proves its own liveness, as the hub asked for it in
   * `hello`. The default matches the hub's own, for a hub too old to say.
   */
  private keepaliveMs = DEFAULT_KEEPALIVE_MS;
  private keepaliveTimer: ReturnType<typeof setInterval> | undefined;

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
    const [deviceId, publicKey, secretSeed, seq, pairedWith] = await Promise.all([
      this.opts.storage.get(this.key('deviceId')),
      this.opts.storage.get(this.key('publicKey')),
      this.opts.storage.get(this.key('secretSeed')),
      this.opts.storage.get(this.key('ackedSeq')),
      this.opts.storage.get(this.key('serverId')),
    ]);
    if (!deviceId || !publicKey || !secretSeed) return false;
    this.deviceId = deviceId;
    this.keys = { publicKey, secretSeed };
    this.ackedSeq = seq ? Number(seq) : 0;
    this.pairedWith = pairedWith ?? undefined;

    // The watchdog spec has to survive an app restart, or closing the app
    // would quietly disable the only thing watching the service.
    const stored = await this.opts.storage.get(this.key('watchdog'));
    if (stored) {
      try {
        // Through the same check the frame gets. This path had none, so the bug
        // that check exists for could come straight back through storage: a spec
        // with no numbers in it makes `intervalMs + graceMs` NaN, `setTimeout`
        // clamps that to 1ms, and a phone with no connectivity then probes in a
        // loop. A spec written by an older build, or a half-written file, is
        // exactly where such a thing comes from.
        this.watchdogSpec = usableWatchdog(JSON.parse(stored) as WatchdogSpec);
      } catch {
        /* a corrupt spec just means we wait for the hub to resend it */
      }
    }
    return true;
  }

  /** Drops the watchdog contract without touching this device's identity. */
  private async forgetWatchdog(): Promise<void> {
    this.watchdogSpec = undefined;
    this.disarmWatchdog();
    this.serviceMissing = false;
    await this.opts.storage.remove(this.key('watchdog')).catch(() => {});
  }

  async forgetCredentials(): Promise<void> {
    this.deviceId = undefined;
    this.keys = undefined;
    this.ackedSeq = 0;
    this.freshlyPaired = false;
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
      this.opts.storage.remove(this.key('serverId')),
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
    this.stopKeepalive();
    this.serviceMissing = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.clearConnectDeadline();
    // Detached before closing, exactly as `open()` does for the socket it
    // replaces. `close()` only begins the closing handshake, so frames already
    // queued on the host's event loop still dispatched into these handlers: a
    // source the user had just muted could ring once more, and a `hello` whose
    // signing resumed after a later `connect()` signed the stale nonce and sent
    // it down the new socket, where `auth_failed` latches `rejected` - no more
    // reconnects until the UI intervenes - and spends the address's ban budget.
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close(1000, 'client closed');
      } catch {
        /* already closing */
      }
    }
    // Failed here rather than left to `onclose`: that handler ignores a socket
    // this method has already dropped, so an outstanding admin call would
    // otherwise sit until its own timeout with no connection left to answer it.
    this.failPendingAdmin('the connection was closed');
    this.setStatus('idle');
  }

  private open(): void {
    // A reconnect already in flight must not race the socket opened here.
    // `connect()` and `pair()` are public and are routinely called while a
    // backoff timer is pending - without this the timer fires anyway and the
    // client ends up holding two sockets, each acknowledging the same alerts.
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;

    // Likewise for a socket that is still open: dropping the reference without
    // closing it leaks the connection and leaves the hub counting a device
    // that nothing is reading from.
    const previous = this.socket;
    if (previous) {
      previous.onopen = previous.onmessage = previous.onclose = previous.onerror = null;
      try {
        previous.close(1000, 'reconnecting');
      } catch {
        /* already closing */
      }
    }

    // Whatever the last socket was proving liveness for is gone.
    this.stopKeepalive();
    this.rejected = false;

    this.setStatus(this.backoff > 0 ? 'reconnecting' : 'connecting');
    const socket = this.opts.createSocket(this.opts.url);
    this.socket = socket;
    this.armConnectDeadline(socket);

    socket.onopen = () => {
      // Nothing to do: the hub speaks first with `hello`, and we cannot sign
      // anything until we have its nonce.
    };
    socket.onmessage = (ev) => {
      // Not `void`: `receive` awaits the host application's crypto and
      // storage, and both can fail for real - a credential truncated by a
      // half-written file, a keystore that is not unlocked yet, a storage
      // backend that throws rather than returning null. That rejection had
      // nowhere to go, so it surfaced as an unhandled rejection and took the
      // process with it: the CLI daemon and the desktop main process both die
      // on one. A client that cannot finish a handshake is broken rather than
      // merely disconnected, so it says so instead of sitting in `connecting`
      // for ever.
      this.receive(String(ev.data)).catch((err) => {
        // Reported, and deliberately not latched into the status. The failure
        // may be incidental to a connection that is otherwise working - the
        // `watchdog` frame persists its spec, so a storage backend that rejects
        // on a full disk lands here on an authenticated, keepaliving socket that
        // is delivering alerts. Marking that `error` had `SourceManager` publish
        // the source as failed and `resume()` tear the healthy socket down on
        // every wake. A handshake that cannot be finished is caught instead by
        // the connect deadline, which drops the socket and retries properly.
        this.emit('error', {
          code: 'client_error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
    };
    socket.onerror = () => {
      this.setStatus('error');
    };
    socket.onclose = () => {
      // A stale socket's close must not disturb the one that replaced it.
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.stopKeepalive();
      // Anything still waiting on this socket will never be answered.
      this.failPendingAdmin('the connection closed before the hub replied');
      if (this.closedByUs || this.status === 'revoked') return;
      // A closed socket is a strong hint, but not proof: reconnecting may
      // succeed immediately. Let the same deadline decide, so a blip during a
      // restart does not page anyone. `armWatchdog` declines outright for a
      // close we asked for.
      this.armWatchdog();
      // Reconnecting without credentials would reopen the socket, be told
      // "unpaired" again, and close - forever, at up to one attempt a second.
      // The UI has to supply a code before there is any point in retrying.
      if (this.status === 'unpaired') return;
      if (this.rejected) return;
      if (!this.opts.autoReconnect) {
        this.setStatus('idle');
        return;
      }
      this.scheduleReconnect();
    };
  }

  /**
   * Gives up on a socket that never finished connecting.
   *
   * Nothing else would. The keepalive only starts at `ready`, the watchdog only
   * arms once a frame has arrived, and `resume()` - the one thing a phone calls
   * on waking - treats `connecting` as progress and declines to interfere. A
   * socket that neither opens nor closes nor errors, which is what a radio
   * switching network mid-connect produces, therefore left the client in
   * `connecting` for ever, receiving nothing, with not one timer pending.
   */
  private armConnectDeadline(socket: SocketLike): void {
    this.clearConnectDeadline();
    this.connectTimer = setTimeout(() => {
      // Only the socket this was armed for, and only while it is still trying.
      if (this.socket !== socket || this.closedByUs) return;
      if (this.status === 'ready') return;

      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      this.socket = undefined;
      this.stopKeepalive();
      try {
        socket.close(1000, 'handshake timed out');
      } catch {
        /* already closing */
      }

      // A pairing attempt is never retried from here. The code may already have
      // been consumed by the attempt that timed out, and replaying it earns a
      // `pair_failed`, which latches `rejected` and stops the client trying
      // anything again until the UI intervenes. Better to say so and let
      // somebody type a fresh code.
      if (this.status === 'pairing') {
        this.pendingCode = undefined;
        this.setStatus('error');
        this.emit('error', {
          code: 'pair_timeout',
          message: 'the hub did not answer the pairing request',
        });
        return;
      }

      // The same rules `onclose` follows, for the same reasons: a client with no
      // credentials would be told "unpaired" again on every attempt, one the hub
      // has rejected must wait for the UI, and `autoReconnect: false` means what
      // it says - which is the CLI's default, so without this a `notifyjs send`
      // against an address that accepts TCP and never speaks retried for ever.
      if (this.status === 'unpaired') return;
      if (this.rejected) return;
      if (!this.opts.autoReconnect) {
        this.setStatus('idle');
        return;
      }

      // Through the backoff rather than straight back out, so a hub that
      // accepts connections and says nothing is not dialled every twenty
      // seconds for the life of the app.
      this.scheduleReconnect();
    }, this.opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
    // Never let this be the reason a process stays alive.
    (this.connectTimer as { unref?: () => void }).unref?.();
  }

  private clearConnectDeadline(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
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
      case 'hello': {
        // A hub that is not the one this device paired with gets nothing: not a
        // signature, not an ack, and no chance to send a `revoked`. Nothing in the
        // protocol authenticates a hub to a device, so an on-path party against a
        // `ws://` hub - the documented LAN default - could otherwise answer at the
        // address, be believed about this device's own role, forge a critical
        // all-clear, ring the machine, and have it speak whatever it liked.
        if (this.pairedWith && msg.serverId !== this.pairedWith) {
          this.setStatus('error');
          this.emit('error', {
            code: 'wrong_hub',
            message: 'this is not the hub this device paired with',
          });
          this.closedByUs = true;
          this.socket?.close(1008, 'wrong hub');
          this.socket = undefined;
          return;
        }
        this.hello = msg;
        this.clockOffset = msg.serverTime - Date.now();
        // A hub that predates keepalives says nothing here, and the default
        // stands. Floored, so a misconfigured hub cannot ask a phone to send a
        // frame every few milliseconds.
        this.keepaliveMs =
          typeof msg.keepaliveMs === 'number' && msg.keepaliveMs >= 1_000
            ? msg.keepaliveMs
            : DEFAULT_KEEPALIVE_MS;
        await this.handshake(msg);
        return;
      }

      case 'paired':
        this.freshlyPaired = true;
        // Pinned from the connection that enrolled this device.
        this.pairedWith = this.hello?.serverId ?? this.pairedWith;
        this.deviceId = msg.deviceId;
        this.role = msg.role;
        this.capabilities = msg.capabilities;
        await this.persistCredentials();
        this.pendingCode = undefined;
        this.emit('paired', { deviceId: msg.deviceId, role: msg.role });
        return;

      case 'ready':
        this.clearConnectDeadline();
        this.backoff = 0;
        this.role = msg.role;
        this.capabilities = msg.capabilities;

        // A device that has just been enrolled starts where the hub says it is.
        // The hub deliberately puts a new device at the head - "a new device
        // gets what happens next, not a replay of every incident from before it
        // existed" - and this client undid that on its first `sync()`, which
        // every app sends on `ready`, on returning to the foreground and on
        // waking: `ackedSeq` was 0, so a freshly paired phone was handed up to
        // `replayLimit` alerts from before it belonged to the hub, each one
        // rendered, sounded and popped.
        //
        // Only the connection that did the pairing may do this. A device
        // reconnecting has a cursor that means something, and moving it forward
        // here would silently discard exactly the backlog replay exists for.
        if (this.freshlyPaired && typeof msg.seq === 'number' && msg.seq > this.ackedSeq) {
          this.ackedSeq = msg.seq;
          void this.opts.storage.set(this.key('ackedSeq'), String(msg.seq)).catch(() => {});
        }
        this.freshlyPaired = false;

        this.startKeepalive();
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

        // These two numbers are handed to `setTimeout`, so they have to be real
        // durations. A frame arriving without them made `intervalMs + graceMs`
        // NaN, which `setTimeout` clamps to 1ms: the alarm fired about a
        // millisecond after connecting and, whenever `isOnline()` reported no
        // connectivity, re-armed itself at the same 1ms - an unbounded loop of
        // connectivity probes on a phone in a tunnel. The spec was persisted, so
        // it outlived a restart.
        //
        // A hub produces such a frame from its own configuration without anybody
        // making a mistake: `{ ...defaults, ...caller }` copies an explicit
        // `undefined` over the default, so one unset key in an application's
        // config was enough.
        //
        // Only nonsense is refused, never a short interval: how often a hub
        // speaks is the hub's own business, and a device watching one that dies
        // inside a second is a real configuration. Ignored rather than repaired
        // with invented numbers - no watchdog is honest, a wrong one is not.
        const usable = usableWatchdog(spec);
        if (!usable) return;

        this.watchdogSpec = usable;
        await this.opts.storage.set(this.key('watchdog'), JSON.stringify(usable));
        this.armWatchdog();
        return;
      }

      case 'beat':
      case 'pong':
        // Both exist only to be traffic: `noteHeardFrom` above has already
        // taken what matters from them.
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
        // The status changes and the keypair stays. Deleting the seed here made an
        // unauthenticated frame - see the `hello` case above - permanently de-pair a
        // device, with no confirmation and nothing to recover from. A revoked device
        // is refused by its hub anyway, so keeping the seed costs nothing, and
        // removing the source still clears it.
        this.setStatus('revoked');
        // The watchdog contract does go: a revoked device that kept it would go on
        // raising "the service is down" about a hub it is no longer entitled to hear
        // from. The keypair is what stays.
        await this.forgetWatchdog();
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
          this.rejected = true;
          // A refused code stays refused; sending it again is only another
          // failure charged to this address.
          this.pendingCode = undefined;
          this.setStatus('error');
        }
        return;

      default:
        return;
    }
  }

  /** The name to send, resolved now rather than when the client was built. */
  private deviceName(): string {
    const name = this.opts.deviceName;
    return typeof name === 'function' ? name() : name;
  }

  private async handshake(hello: HelloMsg): Promise<void> {
    if (this.pendingCode && this.keys) {
      const transcript = canonical([
        SIG_PAIR,
        hello.serverId,
        hello.nonce,
        this.pendingCode,
        this.keys.publicKey,
        this.deviceName(),
        this.opts.platform,
      ]);
      this.send({
        v: PROTOCOL_VERSION,
        t: 'pair',
        code: this.pendingCode,
        publicKey: this.keys.publicKey,
        name: this.deviceName(),
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
      // The hub this device belongs to, so a later connection can tell whether it
      // is talking to the same one. Nothing in the protocol authenticates the hub
      // to the device, so this is the one check available: it does not stop somebody
      // who has read the hub's public `/hub.json`, but it does stop anything that
      // simply answers at the address and claims to be a hub.
      ...(this.hello ? [this.opts.storage.set(this.key('serverId'), this.hello.serverId)] : []),
    ]);
  }

  /* ----------------------------- actions ----------------------------- */

  /** Marks notifications as seen and advances the replay cursor. */
  ack(ids: string[], opts: { seq?: number; action?: string } = {}): void {
    if (opts.seq !== undefined && opts.seq > this.ackedSeq) {
      this.ackedSeq = opts.seq;
      // Swallowed deliberately, but never left to escape: a storage that
      // rejects costs the cursor its persistence, not the process its life.
      void this.opts.storage.set(this.key('ackedSeq'), String(opts.seq)).catch(() => {});
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

  /**
   * Issues a privileged operation; rejects if the role lacks the capability.
   *
   * The result type comes from `AdminData`, keyed on the op, so a caller can no
   * longer describe a reply shape that the hub does not actually send. Every
   * call site used to carry its own annotation, and they had already drifted
   * apart from the hub and from each other.
   */
  admin<Op extends AdminOp>(op: Op, args?: Record<string, unknown>): Promise<AdminResult<Op>> {
    type T = AdminResult<Op>;
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
  /* Application-level keepalive                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Proves, from JavaScript, that this client is still running.
   *
   * The hub also pings at the WebSocket level, but that is answered by the
   * networking library rather than by us - it keeps coming back from a phone
   * whose app the OS has frozen, so the hub goes on believing the alerts it
   * writes into the socket are being read. They are not: they sit in a buffer
   * until the app is opened again. This frame is sent by the same thread that
   * would handle a notification, so it stops the moment that handling would,
   * and the hub can fall back to a push instead of talking to nobody.
   *
   * The same timer is what notices the hub has gone. A socket can be dead
   * without being closed, and until now only the hub's optional watchdog spec
   * would have raised it - and that only ever raised an alarm, never a
   * reconnect.
   */
  private startKeepalive(): void {
    this.stopKeepalive();
    // Anything already received counts; the deadline is silence, not age.
    if (!this.lastHeardAt) this.lastHeardAt = Date.now();

    this.keepaliveTimer = setInterval(() => {
      const silentFor = Date.now() - this.lastHeardAt;
      if (silentFor > this.keepaliveMs * KEEPALIVE_MISSES) {
        // Nothing has come back for several rounds, so the socket is dead
        // whatever it claims. Reconnecting is the only thing that resyncs.
        this.reconnectNow();
        return;
      }
      this.send({ v: PROTOCOL_VERSION, t: 'ping', ts: Date.now() });
    }, this.keepaliveMs);
    // Never let a keepalive be the reason a process stays alive.
    (this.keepaliveTimer as { unref?: () => void }).unref?.();
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = undefined;
  }

  /**
   * Drops the current socket and opens a new one immediately.
   *
   * Not `disconnect()` then `connect()`: that would mark the close as ours and
   * stand the watchdog down, which is wrong for a connection we believe has
   * already failed. The backoff is reset because this is a fresh diagnosis,
   * not another failed attempt in a run of them.
   */
  private reconnectNow(): void {
    if (this.closedByUs) return;
    this.backoff = 0;
    this.lastHeardAt = Date.now();
    this.open();
  }

  /**
   * Called when the host application comes back to life - a phone returning to
   * the foreground, a laptop waking - to close the gap between "we are back"
   * and "we noticed".
   *
   * Everything here is something a timer would eventually have done. The point
   * is that on a suspended phone the timer very likely did not: a backoff of
   * up to thirty seconds, or a keepalive interval, is measured against a clock
   * the OS stopped scheduling, so the app can return to the foreground holding
   * a socket that died an hour ago and a reconnect that was never going to
   * fire.
   */
  resume(): void {
    if (this.closedByUs) return;
    // A device with no credentials, or one the hub has thrown out, reconnects
    // to be told the same thing again. Only the UI can move either along.
    if (this.status === 'unpaired' || this.status === 'revoked') return;
    // A handshake already in flight is progress; restarting it is not.
    if (this.status === 'connecting' || this.status === 'pairing') return;

    // Not connected: retry now rather than waiting out a backoff that was
    // computed for a phone that has since been picked up.
    if (this.status !== 'ready') {
      this.reconnectNow();
      return;
    }

    // Connected, but nothing has been heard for longer than the hub promised.
    if (Date.now() - this.lastHeardAt > this.keepaliveMs * KEEPALIVE_MISSES) {
      this.reconnectNow();
      return;
    }

    // Genuinely still connected, so just ask for anything missed.
    this.sync();
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
    // A client that has deliberately left is not watching anything. Guarding
    // the single place the timer is set covers every route back in - the close
    // handler, and a frame that lands in the moment between `disconnect()` and
    // the socket actually closing, which re-armed it through `noteHeardFrom`.
    if (this.closedByUs) return;

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
   * Registers a browser's Web Push subscription, so the hub can reach this
   * browser while nothing of ours is running - including an iPhone, where a
   * home-screen web app is the only way in without a native build.
   *
   * It takes the subscription whole rather than an endpoint and optional keys,
   * because a signature where the keys are optional is one where forgetting
   * them compiles - and a subscription that cannot be encrypted to is not a
   * subscription. This used to sit beside a second registration method for the
   * Expo transport, which is gone.
   */
  registerWebPush(subscription: { endpoint: string; keys: WebPushKeys }): void {
    this.send({
      v: PROTOCOL_VERSION,
      t: 'push.register',
      token: subscription.endpoint,
      provider: 'webpush',
      keys: subscription.keys,
    });
  }

  /** Withdraws the wake-up subscription. */
  unregisterPush(): void {
    this.send({ v: PROTOCOL_VERSION, t: 'push.register', token: '', provider: 'webpush' });
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

/**
 * Storage backed by `localStorage`, for browsers.
 *
 * Every access is guarded. `localStorage` is not merely absent in some
 * contexts - reading it *throws* when a browser is set to block site data, and
 * `setItem` throws on a full quota or in some private-browsing modes. An
 * uncaught throw here rejected the pairing that was in flight, so a browser
 * with third-party data blocked could not pair at all.
 */
export function webStorage(): ClientStorage {
  const store = (): Storage | undefined => {
    try {
      return globalThis.localStorage ?? undefined;
    } catch {
      return undefined;
    }
  };

  return {
    async get(k) {
      try {
        return store()?.getItem(k) ?? null;
      } catch {
        return null;
      }
    },
    async set(k, v) {
      try {
        store()?.setItem(k, v);
      } catch {
        // Nothing persists, but the credentials still work for this session.
      }
    },
    async remove(k) {
      try {
        store()?.removeItem(k);
      } catch {
        /* nothing to remove if we cannot reach it */
      }
    },
  };
}

/** Storage for tests and short-lived processes. */
/**
 * A watchdog spec this client can actually arm, or nothing.
 *
 * Both the frame and the copy restored from storage go through here. The numbers
 * are handed to `setTimeout`, so a spec without them makes the deadline NaN -
 * which `setTimeout` clamps to 1ms, and the alarm then re-arms itself at that
 * interval for as long as the device reports no connectivity. Only nonsense is
 * refused: how often a hub speaks is the hub's business.
 */
function usableWatchdog(spec: WatchdogSpec | undefined): WatchdogSpec | undefined {
  if (!spec || typeof spec !== 'object') return undefined;

  const intervalMs = Number(spec.intervalMs);
  const graceMs = Number(spec.graceMs);
  const title = spec.alert?.title;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return undefined;
  if (typeof title !== 'string' || title.length === 0) return undefined;

  return {
    enabled: spec.enabled === true,
    intervalMs,
    graceMs: Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : 0,
    alert: spec.alert,
  };
}

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
