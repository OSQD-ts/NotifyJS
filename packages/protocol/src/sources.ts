import { NotifyClient, type ClientStorage, type ConnectionStatus, type SocketLike, type WatchdogSpec } from './client.js';
import { parsePairingLink } from './link.js';
import { severityRank, type CallRequest, type Notification, type Severity } from './types.js';
import type { CryptoProvider } from './crypto.js';

/** A hub this device is subscribed to. */
export interface Source {
  /** Stable local id. Also namespaces this source's stored credentials. */
  id: string;
  url: string;
  /** Name reported by the hub once connected; the URL until then. */
  label: string;
  /** Muted sources stay paired but hold no socket. */
  enabled: boolean;
  addedAt: number;
}

export interface SourceState extends Source {
  status: ConnectionStatus;
  role?: string;
  paired: boolean;
  /** Set when this source's own watchdog says the hub has gone quiet. */
  serviceDown?: { title: string; body?: string };
}

/** A notification, plus which hub it came from. */
export interface SourcedNotification {
  sourceId: string;
  sourceLabel: string;
  notification: Notification;
}

export interface SourcedCall {
  sourceId: string;
  sourceLabel: string;
  call: CallRequest;
}

export interface SourceManagerEvents {
  sources: SourceState[];
  notification: SourcedNotification;
  call: SourcedCall;
  'call.cancel': { sourceId: string; callId: string };
  resolve: { sourceId: string; ids: string[] };
  'service:missing': { sourceId: string; sourceLabel: string; title: string; body?: string };
  'service:back': { sourceId: string };
}

type Handler<K extends keyof SourceManagerEvents> = (payload: SourceManagerEvents[K]) => void;

export interface SourceManagerOptions {
  storage: ClientStorage;
  crypto: CryptoProvider;
  createSocket(url: string): SocketLike;
  platform: string;
  model?: string;
  /** Name registered with every source. Changing it re-registers on connect. */
  deviceName(): string;
  /** Client-side floor, applied after each source's role filter. */
  minSeverity(): Severity;
  isOnline?(): boolean | Promise<boolean>;
}

const INDEX_KEY = 'notifyjs.sources';

/**
 * Subscribes one device to several hubs at once.
 *
 * Each source is a separate identity with its own keypair, role and history —
 * hubs never learn about each other, and revoking a device on one has no
 * bearing on the rest. What this adds is a single merged feed, so a phone can
 * watch a home server, a work hub and a side project without three apps.
 */
export class SourceManager {
  private sources = new Map<string, Source>();
  private clients = new Map<string, NotifyClient>();
  private states = new Map<string, SourceState>();
  private listeners = new Map<string, Set<(payload: never) => void>>();
  /**
   * Guards against `load()` and `add()` racing. A deep link can arrive before
   * the stored subscriptions have finished loading, and without this the load
   * would reconnect the half-paired source *without* its code - silently
   * cancelling the pairing that was already in flight.
   */
  private loading: Promise<void> | undefined;

  constructor(private readonly opts: SourceManagerOptions) {}

  on<K extends keyof SourceManagerEvents>(event: K, handler: Handler<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as (payload: never) => void);
    return () => set!.delete(handler as (payload: never) => void);
  }

  private emit<K extends keyof SourceManagerEvents>(event: K, payload: SourceManagerEvents[K]): void {
    for (const handler of this.listeners.get(event) ?? []) {
      try {
        (handler as Handler<K>)(payload);
      } catch {
        // One misbehaving listener must not stop the others, or a render error
        // in the feed would silently kill call delivery.
      }
    }
  }

  list(): SourceState[] {
    return [...this.sources.values()]
      .sort((a, b) => a.addedAt - b.addedAt)
      .map((s) => this.states.get(s.id) ?? { ...s, status: 'idle', paired: false });
  }

  /** Restores the subscription list and connects everything enabled. */
  load(): Promise<void> {
    // Idempotent: callers may race, and only the first should do the work.
    this.loading ??= this.restore();
    return this.loading;
  }

  private async restore(): Promise<void> {
    const raw = await this.opts.storage.get(INDEX_KEY);
    if (raw) {
      try {
        for (const s of JSON.parse(raw) as Source[]) {
          if (s?.id && s?.url) this.sources.set(s.id, s);
        }
      } catch {
        // A corrupt index costs the subscription list, not the app.
      }
    }
    for (const source of this.sources.values()) {
      // A source added while this was loading already has a live client -
      // reconnecting it here would drop a pairing that is still in progress.
      if (this.clients.has(source.id)) continue;
      if (source.enabled) await this.connect(source);
      else this.setState(source.id, { status: 'idle', paired: true });
    }
    this.publish();
  }

  /**
   * Adds a hub and redeems a pairing code against it. Accepts either a
   * `notifyjs://` link (which carries both) or a URL and code separately.
   */
  async add(input: { link?: string; url?: string; code: string }): Promise<SourceState> {
    await this.load();
    let url = input.url;
    let code = input.code;

    if (input.link) {
      const parsed = parsePairingLink(input.link);
      if (!parsed) throw new Error('that link is not a NotifyJS pairing link');
      url = parsed.hub;
      code = parsed.code;
    }
    if (!url) throw new Error('a hub address is required');
    // A scanned link is already checked; a typed address is not. Both end up
    // in `createSocket`, so the same rule applies to each: this app talks to
    // hubs over WebSocket and to nothing else.
    if (!isHubUrl(url)) throw new Error('a hub address must start with ws:// or wss://');

    // Two subscriptions to the same hub would be two devices competing for the
    // same alerts, which is never what someone means by "add".
    const existing = [...this.sources.values()].find((s) => sameHub(s.url, url!));
    if (existing) throw new Error(`already subscribed to ${existing.label}`);

    const source: Source = {
      id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      url,
      label: hostOf(url),
      enabled: true,
      addedAt: Date.now(),
    };
    this.sources.set(source.id, source);
    await this.persist();

    try {
      await this.connect(source, code);
    } catch (err) {
      // Do not leave a half-added source behind after a failed pairing - and
      // in particular do not leave its client alive. `autoReconnect` means an
      // abandoned client would retry forever, hammering a hub the user has
      // already been told they are not connected to.
      this.clients.get(source.id)?.disconnect();
      this.clients.delete(source.id);
      this.states.delete(source.id);
      this.sources.delete(source.id);
      await this.persist();
      throw err;
    }

    this.publish();
    return this.states.get(source.id)!;
  }

  async remove(id: string): Promise<void> {
    await this.load();
    const client = this.clients.get(id);
    if (client) {
      client.disconnect();
      // Drop the keypair too: leaving it behind would let a stale identity
      // reconnect if the source were ever re-added.
      await client.forgetCredentials();
    }
    this.clients.delete(id);
    this.states.delete(id);
    this.sources.delete(id);
    await this.persist();
    this.publish();
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.load();
    const source = this.sources.get(id);
    if (!source || source.enabled === enabled) return;
    source.enabled = enabled;
    await this.persist();

    if (enabled) {
      await this.connect(source);
    } else {
      this.clients.get(id)?.disconnect();
      this.clients.delete(id);
      this.setState(id, { status: 'idle' });
    }
    this.publish();
  }

  /** Reconnects everything; used when the app returns to the foreground. */
  syncAll(): void {
    for (const client of this.clients.values()) client.sync();
  }

  snoozeAll(durationMs: number): void {
    for (const client of this.clients.values()) client.snooze(durationMs);
  }

  unsnoozeAll(): void {
    for (const client of this.clients.values()) client.unsnooze();
  }

  disconnectAll(): void {
    for (const client of this.clients.values()) client.disconnect();
    this.clients.clear();
  }

  /* --------------------------- per-source actions -------------------- */

  ack(sourceId: string, ids: string[], opts?: { seq?: number; action?: string }): void {
    this.clients.get(sourceId)?.ack(ids, opts ?? {});
  }

  answerCall(sourceId: string, callId: string): void {
    this.clients.get(sourceId)?.answerCall(callId);
  }

  declineCall(sourceId: string, callId: string): void {
    this.clients.get(sourceId)?.declineCall(callId);
  }

  endCall(sourceId: string, callId: string): void {
    this.clients.get(sourceId)?.endCall(callId);
  }

  registerPush(sourceId: string, token: string): void {
    this.clients.get(sourceId)?.registerPush(token);
  }

  /* ------------------------------ internals -------------------------- */

  private async connect(source: Source, pairingCode?: string): Promise<void> {
    this.clients.get(source.id)?.disconnect();

    const client = new NotifyClient({
      url: source.url,
      crypto: this.opts.crypto,
      storage: this.opts.storage,
      createSocket: this.opts.createSocket,
      deviceName: this.opts.deviceName(),
      platform: this.opts.platform,
      model: this.opts.model,
      autoReconnect: true,
      // Each source keeps its own keypair under its own namespace, so one
      // identity can never be used against another hub.
      storagePrefix: `notifyjs.${source.id}`,
      isOnline: this.opts.isOnline,
    });
    this.clients.set(source.id, client);
    this.wire(source, client);

    if (pairingCode) {
      let settle: (() => void) | undefined;
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the hub did not respond')), 20_000);
        const offReady = client.on('ready', () => resolve());
        const offError = client.on('error', (e) => reject(new Error(e.message)));
        settle = () => {
          clearTimeout(timer);
          offReady();
          offError();
        };
      });
      // Attached before anything can throw. `client.pair()` rejects for
      // ordinary reasons - a hub that moved, a socket refused - and the
      // 20-second timer above would then reject a promise nobody was left
      // awaiting, surfacing as an unhandled rejection well after the caller
      // had already been told what went wrong.
      ready.catch(() => {});
      try {
        await client.pair(pairingCode);
        await ready;
      } finally {
        // The timer and both listeners go either way, so a failed pairing does
        // not leave a handler attached to a client that is about to be dropped.
        settle?.();
      }
    } else {
      await client.connect();
    }
  }

  private wire(source: Source, client: NotifyClient): void {
    const label = () => this.sources.get(source.id)?.label ?? source.url;

    client.on('status', (status) => {
      this.setState(source.id, { status });
      this.publish();
    });

    client.on('ready', (ready) => {
      // The hub's own name beats a hostname once we have it.
      const known = this.sources.get(source.id);
      if (known && client.serverName && known.label !== client.serverName) {
        known.label = client.serverName;
        void this.persist();
      }
      this.setState(source.id, { status: 'ready', paired: true, role: ready.role });
      this.publish();
    });

    client.on('notification', (n) => {
      if (severityRank(n.severity) < severityRank(this.opts.minSeverity())) {
        // Still acknowledged: the person chose not to see it, which is not the
        // same as never having received it.
        client.ack([n.id], { seq: n.seq });
        return;
      }
      this.emit('notification', { sourceId: source.id, sourceLabel: label(), notification: n });
      client.ack([n.id], { seq: n.seq });
    });

    client.on('call', (call) => {
      this.emit('call', { sourceId: source.id, sourceLabel: label(), call });
    });

    client.on('call.cancel', ({ callId }) => {
      this.emit('call.cancel', { sourceId: source.id, callId });
    });

    client.on('resolve', ({ ids }) => {
      this.emit('resolve', { sourceId: source.id, ids });
    });

    client.on('service:missing', ({ spec }) => {
      this.setState(source.id, {
        serviceDown: { title: spec.alert.title, body: spec.alert.body },
      });
      this.emit('service:missing', {
        sourceId: source.id,
        sourceLabel: label(),
        title: spec.alert.title,
        body: spec.alert.body,
      });
      this.publish();
    });

    client.on('service:back', () => {
      this.setState(source.id, { serviceDown: undefined });
      this.emit('service:back', { sourceId: source.id });
      this.publish();
    });

    client.on('revoked', () => {
      this.setState(source.id, { status: 'revoked', paired: false });
      this.publish();
    });
  }

  private setState(id: string, patch: Partial<SourceState>): void {
    const source = this.sources.get(id);
    if (!source) return;
    const current = this.states.get(id) ?? { ...source, status: 'idle', paired: false };
    this.states.set(id, { ...current, ...source, ...patch });
  }

  private publish(): void {
    this.emit('sources', this.list());
  }

  private async persist(): Promise<void> {
    await this.opts.storage.set(INDEX_KEY, JSON.stringify([...this.sources.values()]));
  }
}

/** Compares hubs by host and port, ignoring incidental URL differences. */
function sameHub(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.host === ub.host;
  } catch {
    return a === b;
  }
}

/** The only addresses a source may be created for. */
function isHubUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'ws:' || protocol === 'wss:';
  } catch {
    return false;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export type { WatchdogSpec };
