import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';
import {
  NotifyClient,
  type CallResult,
  type ClientStorage,
  type EscalationPolicy,
  type Notification,
  type Severity,
} from '@osqd/notifyjs-protocol';
import { nodeCrypto } from '@osqd/notifyjs-protocol/node';

import type { CallInput, NotifyInput } from './server.js';
import type { Heartbeat, HeartbeatSpec } from './watchdog.js';

export interface RemoteNotifierOptions {
  /** The hub to send to, e.g. `wss://alerts.example.com:7741`. */
  url: string;
  /** Credential storage. Defaults to a file under `~/.notifyjs`. */
  storage?: ClientStorage;
  /** Pairing code, redeemed on first connect if this app is not yet paired. */
  pairingCode?: string;
  /** Name this app registers under. */
  name?: string;
  /** Wait this long for the hub before giving up on a send. */
  timeoutMs?: number;
  /**
   * Keep trying to reach the hub in the background. Sends made while
   * disconnected fail fast rather than queueing.
   */
  autoReconnect?: boolean;
}

/**
 * Sends to a hub running somewhere else.
 *
 * `Notifier` embeds the hub in your process, which is simple and has one
 * fatal property: when the process dies, the hub dies with it, so the single
 * alert you most want - "the service is down" - is the one it structurally
 * cannot send.
 *
 * This is the other half. Run a hub somewhere that outlives your app
 * (`notifyjs serve`, a container, a spare box), point this at it, and register
 * a heartbeat. Now silence is itself an alert.
 *
 * The API mirrors `Notifier` so moving between embedded and remote is a change
 * of constructor, not of every call site.
 */
export class RemoteNotifier {
  private readonly client: NotifyClient;
  private ready: Promise<void> | undefined;

  constructor(private readonly opts: RemoteNotifierOptions) {
    this.client = new NotifyClient({
      url: opts.url,
      crypto: nodeCrypto,
      storage: opts.storage ?? defaultStorage(),
      createSocket: (url) => new WebSocket(url) as never,
      deviceName: opts.name ?? `app@${process.env.HOSTNAME ?? 'localhost'}`,
      platform: process.platform,
      model: 'notifyjs-remote',
      autoReconnect: opts.autoReconnect ?? true,
    });
  }

  /**
   * Connects and authenticates, pairing first if a code was supplied and this
   * app has no credentials yet. Safe to call repeatedly; the work happens once.
   */
  connect(): Promise<void> {
    // A failed attempt must not be cached: holding on to the rejected promise
    // would turn one unreachable moment - a hub still booting, a flapping
    // network - into a notifier that refuses to connect for the rest of the
    // process's life, with the original error repeated forever.
    this.ready ??= this.establish().catch((err: unknown) => {
      this.ready = undefined;
      throw err;
    });
    return this.ready;
  }

  private async establish(): Promise<void> {
    // Every listener is removed on settle. `establish()` runs again after a
    // failure or a `disconnect()`, and leaving them attached would accumulate
    // a set of handlers per attempt on a long-lived client.
    const offs: (() => void)[] = [];
    const settled = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out connecting to ${this.opts.url}`)),
        this.opts.timeoutMs ?? 15_000,
      );
      const finish = (fn: () => void) => {
        clearTimeout(timer);
        fn();
      };

      offs.push(this.client.on('ready', () => finish(resolve)));
      offs.push(
        this.client.on('error', (err) => finish(() => reject(new Error(err.message)))),
      );
      offs.push(
        this.client.on('status', (status) => {
          if (status !== 'unpaired') return;
          finish(() =>
            reject(
              new Error(
                'this app is not paired with the hub - pass `pairingCode`, or run: notifyjs pair <code>',
              ),
            ),
          );
        }),
      );
    });

    try {
      if (this.opts.pairingCode && !(await this.client.isPaired())) {
        await this.client.pair(this.opts.pairingCode);
      } else {
        await this.client.connect();
      }
      await settled;
    } finally {
      for (const off of offs) off();
    }
  }

  disconnect(): void {
    this.client.disconnect();
    this.ready = undefined;
  }

  get connected(): boolean {
    return this.client.status === 'ready';
  }

  /* --------------------------- notifications -------------------------- */

  async notify(input: NotifyInput | string): Promise<void> {
    await this.connect();
    const payload = typeof input === 'string' ? { title: input } : input;
    await this.client.admin('notify.send', payload as unknown as Record<string, unknown>);
  }

  debug(input: NotifyInput | string): Promise<void> {
    return this.notify(withSeverity(input, 'debug'));
  }
  info(input: NotifyInput | string): Promise<void> {
    return this.notify(withSeverity(input, 'info'));
  }
  success(input: NotifyInput | string): Promise<void> {
    return this.notify(withSeverity(input, 'success'));
  }
  warn(input: NotifyInput | string): Promise<void> {
    return this.notify(withSeverity(input, 'warning'));
  }
  error(input: NotifyInput | string): Promise<void> {
    return this.notify(withSeverity(input, 'error'));
  }
  critical(input: NotifyInput | string): Promise<void> {
    return this.notify(withSeverity(input, 'critical'));
  }

  async resolve(target: string | { id?: string; key?: string }): Promise<string[]> {
    await this.connect();
    const spec = typeof target === 'string' ? { key: target } : target;
    const out = await this.client.admin<{ resolved: string[] }>('notify.resolve', spec);
    return out.resolved ?? [];
  }

  /* ------------------------------- calls ------------------------------ */

  /**
   * Places a call. Unlike the embedded `Notifier`, this resolves as soon as
   * the hub accepts the request: the outcome is decided on the hub, which may
   * still be ringing long after this app has moved on.
   */
  async call(input: CallInput | string): Promise<void> {
    await this.connect();
    const payload = typeof input === 'string' ? { message: input } : input;
    await this.client.admin('call.place', payload as unknown as Record<string, unknown>);
  }

  /* ----------------------------- heartbeats --------------------------- */

  /**
   * Registers a check-in the hub should expect from this app, and starts
   * sending it automatically on a timer.
   *
   * The interval is deliberately a fraction of the deadline, so a single
   * missed tick - a slow GC pause, a blip in the network - does not raise a
   * false alarm.
   */
  async expect(name: string, spec: HeartbeatSpec): Promise<Heartbeat> {
    await this.connect();
    const out = await this.client.admin<{ heartbeat: Heartbeat }>('heartbeat.expect', {
      name,
      ...spec,
    } as unknown as Record<string, unknown>);
    return out.heartbeat;
  }

  async checkIn(name: string): Promise<boolean> {
    await this.connect();
    const out = await this.client.admin<{ known: boolean }>('heartbeat.checkin', { name });
    return out.known ?? false;
  }

  /**
   * Declares a heartbeat and keeps it alive for as long as this process is
   * running. Returns a stop function.
   *
   * This is the dead-man's switch in one call: while the app is healthy the
   * timer keeps checking in, and the moment it stops - crash, hang, power cut -
   * the hub notices and raises the alarm the app could never send itself.
   */
  async keepAlive(name: string, spec: HeartbeatSpec): Promise<() => void> {
    const beat = await this.expect(name, spec);

    // Check in about three times per interval so a single lost tick is not an
    // incident. The floor must stay well inside the deadline - a fixed one
    // second would overshoot a two-second heartbeat and manufacture the very
    // alert this is meant to prevent.
    const deadline = beat.every + beat.grace;
    const period = Math.max(200, Math.min(Math.floor(beat.every / 3), Math.floor(deadline / 2)));
    const timer = setInterval(() => {
      void this.checkIn(name).catch(() => {
        // A failed check-in is itself the signal; the hub will notice.
      });
    }, period);
    timer.unref?.();

    void this.checkIn(name).catch(() => {});
    return () => clearInterval(timer);
  }

  /* ------------------------------ policies ---------------------------- */

  async upsertPolicy(policy: EscalationPolicy): Promise<void> {
    await this.connect();
    await this.client.admin('policies.upsert', policy as unknown as Record<string, unknown>);
  }

  async history(limit = 100): Promise<Notification[]> {
    await this.connect();
    const out = await this.client.admin<{ notifications: Notification[] }>('history', { limit });
    return out.notifications ?? [];
  }
}

function withSeverity(input: NotifyInput | string, severity: Severity): NotifyInput {
  return typeof input === 'string' ? { title: input, severity } : { ...input, severity };
}

/**
 * Credentials live beside the CLI's, so `notifyjs pair` and an embedding app
 * share one identity on the same machine.
 */
function defaultStorage(): ClientStorage {
  const file = join(homedir(), '.notifyjs', 'credentials.json');
  const load = (): Record<string, string> => {
    if (!existsSync(file)) return {};
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  };
  const save = (data: Record<string, string>) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
    // `mode` above only applies when the file is created; restate it so an
    // existing file cannot keep looser permissions than it should have.
    try {
      chmodSync(file, 0o600);
    } catch {
      /* a filesystem without POSIX modes; nothing to enforce */
    }
  };

  return {
    async get(key) {
      return load()[key] ?? null;
    },
    async set(key, value) {
      const data = load();
      data[key] = value;
      save(data);
    },
    async remove(key) {
      const data = load();
      delete data[key];
      save(data);
    },
  };
}
