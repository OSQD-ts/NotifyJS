import { EventEmitter } from 'node:events';
import { networkInterfaces } from 'node:os';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createRequire } from 'node:module';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, normalize, extname, resolve as resolvePath } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';

import {
  PROTOCOL_VERSION,
  SIG_AUTH,
  SIG_PAIR,
  buildPairingLink,
  canDeliver,
  canonical,
  encodePairingCode,
  escalatingCapabilities,
  hasCapability,
  isPairingCodeValid,
  normalizePairingCode,
  pairingCodeHash,
  coerceSeverity,
  sanitizeRole,
  timingSafeEqual,
  toBase64Url,
  type AuditEvent,
  type CallRequest,
  type CallResult,
  type Capability,
  type ClientMessage,
  type Device,
  type WebPushKeys,
  type Notification,
  type NotificationAction,
  type EscalationPolicy,
  type Role,
  type Severity,
  type Targeting,
} from '@osqd/notifyjs-protocol';
import { nodeCrypto } from '@osqd/notifyjs-protocol/node';

import { resolveOptions, type NotifierOptions, type ResolvedOptions } from './options.js';
import { Store } from './store.js';
import {
  Guard,
  MessageLimiter,
  compileIpList,
  matchesIp,
  normalizeIp,
  uniformDelay,
} from './guard.js';
import {
  bearerFrom,
  findIngestToken,
  isLoopback,
  mintIngestToken,
  tokenMay,
  type IngestToken,
} from './ingest.js';
import { Session } from './session.js';
import { CallOrchestrator, type CallEvent, type CallStep, type CallTarget } from './calls.js';
import { Watchdog, formatDuration, type Heartbeat, type HeartbeatSpec, parseDuration } from './watchdog.js';
import { Metrics } from './metrics.js';
import { FloodControl, summaryTitle, type FloodSummary } from './flood.js';
import { WebPushSender, generateVapidKeys } from './webpush.js';
import { renderQr } from './qr.js';

export interface NotifyInput {
  channel?: string;
  severity?: Severity;
  title: string;
  body?: string;
  tags?: string[];
  data?: Record<string, unknown>;
  actions?: NotificationAction[];
  /**
   * Keep re-delivering until a device acknowledges it, or the TTL expires.
   *
   * A device, not a person: every client acks on receipt. See
   * `scheduleAckRetry`.
   */
  requireAck?: boolean;
  ttl?: number;
  to?: Targeting;
  /**
   * Groups repeats for flood control. Defaults to severity + channel + title,
   * which is usually what you want; set it explicitly when the title varies
   * but the incident does not.
   */
  dedupeKey?: string;
  /**
   * Ties this alert to a later `resolve()`, so the banner clears everywhere
   * when the condition ends.
   */
  resolveKey?: string;
}

export interface CallInput {
  message: string;
  channel?: string;
  severity?: Severity;
  from?: string;
  lang?: string;
  rate?: number;
  pitch?: number;
  ringSeconds?: number;
  repeat?: number;
  to?: Targeting;
  /** Ring one device at a time (default) rather than all at once. */
  escalate?: boolean;
  /** Name of an escalation policy to follow instead of `escalate`. */
  policy?: string;
}

export interface PairingCodeInput {
  role?: string;
  /** Lifetime of the code. Short by design; the default is 10 minutes. */
  ttlMs?: number;
  uses?: number;
  allowIps?: string[];
  label?: string;
}

export interface IssuedPairingCode {
  code: string;
  role: string;
  expiresAt: number;
  /** Deep link carrying both the hub address and the code. */
  link: string;
  /** The same link as a QR code, for scanning with a phone. */
  qr: { svg: string; terminal: string };
}

/**
 * What `notify()` returns: the notification, plus what became of it.
 *
 * An alert that reached nobody looks identical to a delivered one unless the
 * caller is told, which for an alerting library is the question that matters.
 */
export interface SentNotification extends Notification {
  /** Devices the notification was delivered to at send time. */
  reached: number;
  deliveredTo: string[];
  /** True when flood control held this one back for a summary. */
  coalesced: boolean;
}

export interface NotifierEvents {
  listening: [{ url: string; port: number }];
  'device:paired': [Device];
  'device:online': [Device];
  'device:offline': [Device];
  'device:revoked': [Device];
  notification: [Notification];
  ack: [{ notificationId: string; deviceId: string; action?: string }];
  /**
   * Somebody pressed one of a notification's buttons.
   *
   * Separate from `ack` because it means something different and an
   * application will want to act on it rather than record it. Emitted only
   * once per notification, for an action it published, from a device whose
   * role carries `notify.act`.
   */
  action: [{ notificationId: string; actionId: string; deviceId: string; deviceName: string }];
  call: [CallEvent];
  'heartbeat:missed': [{ heartbeat: Heartbeat; overdueBy: number }];
  'heartbeat:recovered': [Heartbeat];
  'auth:failed': [{ ip: string; reason: string }];
  banned: [{ ip: string; until: number }];
  error: [Error];
}

/**
 * The hub. Construct it inside your app, `start()` it, and call `notify.error()`
 * or `notify.call()` wherever something worth knowing about happens.
 *
 * It owns a WebSocket server on `port` (7741 by default) that devices connect
 * to directly - there is no relay in the middle and no third-party push
 * service, so the notification never leaves infrastructure you control.
 */
export class Notifier extends EventEmitter<NotifierEvents> {
  private readonly opts: ResolvedOptions;
  private readonly store: Store;
  private readonly guard: Guard;
  private readonly calls: CallOrchestrator;
  private readonly flood: FloodControl;
  private readonly webPush: WebPushSender;
  private readonly watchdog: Watchdog;
  private readonly metrics = new Metrics();
  private readonly sessions = new Map<string, Session>();
  /** deviceId -> sessions. A device may legitimately hold more than one. */
  private readonly byDevice = new Map<string, Set<Session>>();
  private readonly ackWaiters = new Map<string, NodeJS.Timeout>();
  /** Per-token publish limiters, created on first use and dropped on revoke. */
  private readonly ingestLimiters = new Map<string, MessageLimiter>();

  /** Pushes proof of life so a quiet hub still produces observable traffic. */
  private beatTimer: NodeJS.Timeout | undefined;

  private http: ReturnType<typeof createHttpServer> | undefined;
  private wss: WebSocketServer | undefined;
  private dashboardRoot: string | undefined;
  private started = false;

  constructor(options: NotifierOptions = {}) {
    super();
    this.opts = resolveOptions(options);
    this.store = new Store(
      this.opts.storeDir,
      { history: this.opts.historyLimit, audit: this.opts.auditLimit },
      () => randomId(8),
    );
    // Said as loudly as a constructor can: every paired device is about to fail
    // to authenticate, because the serverId their signatures are bound to is
    // gone with the store. Without this the operator sees only every device
    // breaking at once, with nothing anywhere explaining why.
    if (this.store.recoveredFrom) {
      this.opts.logger(
        'the store could not be read and was started over - every device must pair again',
        { keptAt: this.store.recoveredFrom },
      );
      this.audit('store.recovered', { detail: { keptAt: this.store.recoveredFrom } });
    }

    this.guard = new Guard(this.opts.security, this.store);
    this.calls = new CallOrchestrator(this.opts.defaultRingSeconds, (e) => {
      this.emit('call', e);
      this.audit(`call.${e.type}`, { detail: { callId: e.callId } });
    });
    this.flood = new FloodControl(this.opts.flood, (summary) => this.releaseSummary(summary));
    // The same retirement rule as above, and the same reason for it: an
    // endpoint a push service answers 404 or 410 for will never deliver again,
    // and nothing else in the system would ever notice.
    this.webPush = new WebPushSender(
      this.opts.webPush,
      () => this.store.vapid(generateVapidKeys),
      this.opts.logger,
      (ok, count) => this.metrics.pushed(ok, count),
      (deviceId) => {
        const updated = this.store.updateDevice(deviceId, {
          pushToken: undefined,
          pushProvider: undefined,
          pushKeys: undefined,
        });
        if (!updated) return;
        for (const session of this.byDevice.get(deviceId) ?? []) session.device = updated;
        this.audit('push.unreachable', { deviceId });
      },
    );

    this.watchdog = new Watchdog(
      (event) => this.onHeartbeatMissed(event),
      (beat) => this.onHeartbeatRecovered(beat),
      this.opts.heartbeatTickMs,
    );
    // Heartbeats outlive the process they watch, which is the entire point.
    this.watchdog.restore(this.store.heartbeats());
  }

  /* ------------------------------------------------------------------ */
  /* Heartbeats                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Declares a check-in the hub should expect.
   *
   * This is the only mechanism here that catches a process which has died
   * rather than misbehaved: everything else reacts to an alert being sent, and
   * a crashed service sends nothing at all. For it to be worth anything, the
   * hub has to outlive what it watches - run `notifyjs serve` separately and
   * have the monitored process check in with a `RemoteNotifier`.
   */
  expect(name: string, spec: HeartbeatSpec): Heartbeat {
    // Validated before the watchdog is touched. `heartbeat.expect` is reachable
    // over the wire, and the store rightly refuses a `__proto__` key - but it
    // refused it *after* the watchdog had already registered the beat, leaving
    // one that alerted forever and never survived a restart.
    const clean = sanitizeName(name);
    if (!clean) throw new Error('a heartbeat needs a name');
    if (clean === '__proto__' || clean === 'constructor' || clean === 'prototype') {
      throw new Error(`"${clean}" cannot be used as a heartbeat name`);
    }

    const beat = this.watchdog.expect(clean, spec);
    try {
      this.store.putHeartbeat(beat);
    } catch (err) {
      // Keep the two in step: a beat the store will not hold is one the
      // watchdog must not be left holding either.
      this.watchdog.forget(clean);
      throw err;
    }
    this.audit('heartbeat.expected', { detail: { name: clean, every: beat.every } });
    return beat;
  }

  /** Records a check-in. False means nothing was expecting one by that name. */
  checkIn(name: string): boolean {
    const known = this.watchdog.checkIn(name);
    if (known) {
      const beat = this.watchdog.get(name);
      if (beat) this.store.putHeartbeat(beat);
    }
    return known;
  }

  forget(name: string): boolean {
    this.store.deleteHeartbeat(name);
    return this.watchdog.forget(name);
  }

  heartbeats(): Heartbeat[] {
    return this.watchdog.list();
  }

  private onHeartbeatMissed(event: { heartbeat: Heartbeat; overdueBy: number }): void {
    const { heartbeat, overdueBy } = event;
    this.store.putHeartbeat(heartbeat);
    this.metrics.heartbeatMissed();
    this.emit('heartbeat:missed', event);

    const overdue = formatDuration(overdueBy);
    void this.notify({
      title: `No check-in from "${heartbeat.name}"`,
      body:
        (heartbeat.description ? `${heartbeat.description}\n\n` : '') +
        `Expected every ${formatDuration(heartbeat.every)}` +
        (heartbeat.grace ? ` (plus ${formatDuration(heartbeat.grace)} grace)` : '') +
        `, but nothing has arrived for ${overdue}.`,
      channel: heartbeat.channel,
      severity: heartbeat.severity,
      tags: ['heartbeat', heartbeat.name],
      // Keyed so the recovery below clears it from every screen.
      resolveKey: `heartbeat:${heartbeat.name}`,
      requireAck: true,
    });
  }

  private onHeartbeatRecovered(heartbeat: Heartbeat): void {
    this.store.putHeartbeat(heartbeat);
    this.emit('heartbeat:recovered', heartbeat);
    void this.resolve({ key: `heartbeat:${heartbeat.name}` });
    // Sent at the heartbeat's own severity, not as a cheerful 'success': the
    // recovery has to reach exactly the people the alert reached, and a role
    // paged at 'critical' filters out anything gentler.
    void this.notify({
      title: `"${heartbeat.name}" is checking in again`,
      body: 'The missed check-in has been cleared.',
      channel: heartbeat.channel,
      severity: heartbeat.severity,
      tags: ['heartbeat', heartbeat.name, 'recovered'],
    });
  }

  /* ------------------------------------------------------------------ */
  /* Resolving                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Clears alerts whose condition has ended.
   *
   * Without this, a screen fills with warnings that stopped being true hours
   * ago, and people learn to ignore the feed.
   */
  async resolve(target: string | { id?: string; key?: string }): Promise<string[]> {
    const spec = typeof target === 'string' ? { key: target } : target;
    const now = Date.now();

    const matched = this.store.history().filter((n) => {
      if (n.resolvedAt) return false;
      if (spec.id) return n.id === spec.id;
      if (spec.key) return n.resolveKey === spec.key;
      return false;
    });
    if (matched.length === 0) return [];

    for (const n of matched) n.resolvedAt = now;
    this.store.touchHistory();

    const ids = matched.map((n) => n.id);

    // Filtered per device, like every other fan-out in this file. This was the one
    // that was not: it sent every resolved id and the `resolveKey` to every
    // connected device, and resolve keys are written to be descriptive -
    // `incident:ceo-laptop`, `heartbeat:nightly-payroll` - so a role excluded from a
    // channel learned the names of incidents on it anyway. The rule this breaks is
    // stated plainly in SECURITY.md: reading is filtered the same way as delivery,
    // or the capability that puts a device on the receiving end of one channel is a
    // way to read every other.
    //
    // A device whose role has narrowed since it saw the alert no longer gets the
    // resolution, which is the same retroactive narrowing replay already applies.
    for (const session of this.sessions.values()) {
      if (session.state !== 'ready') continue;
      const visible = matched
        .filter((n) => this.allowed(session, n.channel, n.severity, n.to, false))
        .map((n) => n.id);
      if (visible.length === 0) continue;
      session.send({ v: PROTOCOL_VERSION, t: 'resolve', ids: visible, key: spec.key });
    }

    // A resolved alert must stop nagging, or `requireAck` outlives the incident.
    for (const id of ids) {
      const timer = this.ackWaiters.get(id);
      if (timer) clearTimeout(timer);
      this.ackWaiters.delete(id);
    }

    this.audit('notify.resolved', { detail: { ids, key: spec.key } });
    return ids;
  }

  /* ------------------------------------------------------------------ */
  /* Escalation policies                                                 */
  /* ------------------------------------------------------------------ */

  policies(): EscalationPolicy[] {
    return this.store.policies();
  }

  /**
   * Stores an escalation ladder.
   *
   * `policies.upsert` is reachable from any device holding `roles.manage`, and
   * every number in the result is handed straight to `setTimeout` or used as a
   * loop bound. Unclamped, one frame buys a ladder that rings for a century, or
   * repeats without end, or carries a hundred thousand rungs - so the shape is
   * normalised here rather than trusted.
   */
  upsertPolicy(policy: EscalationPolicy): void {
    this.store.putPolicy(sanitizePolicy(policy));
    this.audit('policy.upsert', {
      detail: { name: policy.name, steps: policy.steps?.length ?? 0 },
    });
  }

  deletePolicy(name: string): boolean {
    return this.store.deletePolicy(name);
  }

  /**
   * Publishes the single notification standing in for everything a flood
   * window held back. It bypasses flood control itself, or the summary could
   * be swallowed by the very window that produced it.
   */
  private releaseSummary(summary: FloodSummary): void {
    const n = this.buildNotification({
      title: summaryTitle(summary),
      body: summary.sample.body,
      channel: summary.sample.channel,
      severity: summary.sample.severity,
      tags: [...(summary.sample.tags ?? []), 'coalesced'],
      data: {
        occurrences: summary.total,
        suppressed: summary.suppressed,
        windowMs: summary.windowMs,
      },
    });
    this.store.pushHistory(n);
    const deliveredTo = this.deliver(n);
    this.emit('notification', n);
    this.metrics.summarised();
    this.audit('notify.summary', {
      detail: { id: n.id, occurrences: summary.total },
    });
    void this.pushToOffline(n, deliveredTo);
  }

  /**
   * Wakes devices that are allowed to see this notification but are not
   * currently connected. No-op unless push is explicitly enabled.
   */
  private async pushToOffline(n: Notification, deliveredTo: string[]): Promise<void> {
    if (!this.webPush.enabled) return;
    const online = new Set(this.opts.webPush.evenWhenOnline ? [] : deliveredTo);

    const targets = this.store.devices().filter((device) => {
      if (!device.pushToken || device.status !== 'active') return false;
      if (online.has(device.id)) return false;
      // The same rule the socket path applies. Without it a snooze was not just
      // ignored here, it was the reason the push happened.
      if (snoozeHolds(device, n.severity)) return false;
      const role = this.store.role(device.role);
      if (!role) return false;
      return canDeliver({
        role,
        deviceId: device.id,
        channel: n.channel,
        severity: n.severity,
        to: n.to,
        isCall: false,
      });
    });

    await this.webPush.send(webPushTargets(targets), {
      title: `${n.severity.toUpperCase()}: ${n.title}`,
      body: this.opts.webPush.includeBody ? (n.body ?? n.channel) : n.channel,
      // The notification id, so a repeat of the same alert replaces the one
      // already on screen rather than stacking beside it.
      tag: n.id,
      severity: n.severity,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  get serverId(): string {
    return this.store.serverId;
  }

  get url(): string {
    const scheme = this.opts.tls ? 'wss' : 'ws';
    const host = this.opts.host === '0.0.0.0' ? 'localhost' : this.opts.host;
    return `${scheme}://${host}:${this.opts.port}`;
  }

  get dashboardUrl(): string {
    return this.url.replace(/^ws/, 'http');
  }

  async start(): Promise<this> {
    if (this.started) return this;
    this.started = true;

    if (this.opts.dashboard) this.dashboardRoot = await this.locateDashboard();

    const handler = (req: IncomingMessage, res: ServerResponse) => {
      this.handleHttp(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    };

    this.http = this.opts.tls
      ? (createHttpsServer(
          {
            // A floor, not a ceiling: the caller's own options win, so an
            // operator can still require 1.3. Stated because the alternative
            // is inheriting whatever the process default happens to be, and a
            // hub that quietly accepts TLS 1.0 is worse than one with no TLS,
            // which at least does not claim to be protected.
            minVersion: 'TLSv1.2',
            honorCipherOrder: true,
            ...this.opts.tls,
          },
          handler,
        ) as unknown as ReturnType<typeof createHttpServer>)
      : createHttpServer(handler);

    // `noServer` keeps the upgrade in our hands, so an abusive peer is rejected
    // before `ws` allocates a connection for it.
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: this.opts.security.maxMessageBytes,
    });
    this.http.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));

    // Slowloris: a socket that connects and then says nothing must not hold a
    // slot open indefinitely.
    this.http.headersTimeout = 10_000;
    this.http.requestTimeout = 20_000;

    try {
      await new Promise<void>((res, rej) => {
        this.http!.once('error', rej);
        this.http!.listen(this.opts.port, this.opts.host, () => {
          this.http!.off('error', rej);
          res();
        });
      });
    } catch (err) {
      // Unwound completely, so a caller may try again - on another port, or
      // once whatever held this one has let go.
      //
      // Without this, `started` stayed true after the commonest startup
      // failure there is, and the retry took the early return at the top of
      // this method: `start()` resolved, `url` named a plausible address, and
      // nothing was listening. An alerting hub that believes it is up is worse
      // than one that refuses to start.
      this.wss?.close();
      this.wss = undefined;
      this.http?.close();
      this.http = undefined;
      this.started = false;
      throw err;
    }

    // Port 0 means "any free port", and the caller has no other way to learn
    // which one it got. Without reading it back, `url`, `publicUrl`, every
    // pairing link and the `listening` event would all report 0 - a hub that
    // is running and reachable but cannot tell anybody where.
    const bound = this.http.address();
    if (bound && typeof bound === 'object') this.opts.port = bound.port;

    // Everything `stop()` shut down comes back with the hub. These were armed
    // once, at construction, so a stopped-and-restarted hub silently ran
    // without its IP sweeper and without checking a single heartbeat.
    //
    // The store belongs on that list too: `stop()` closes it, and a closed store
    // refuses to schedule a write - so without this nothing the hub's second life
    // did would ever reach disk.
    this.store.reopen();
    this.guard.start();
    this.watchdog.start();

    // Always armed, whether or not devices are watching the hub back: this
    // timer is how the hub notices a device has gone, which is a separate
    // question from `deviceWatchdog` and must not share its switch.
    this.beatTimer = setInterval(() => {
      if (this.opts.deviceWatchdog.enabled) this.beat();
      this.sweepDeadSockets();
    }, this.opts.livenessIntervalMs);
    this.beatTimer.unref?.();

    this.http.on('error', (err) => this.emit('error', err));
    this.opts.logger(`hub listening on ${this.url}`, {
      dashboard: this.opts.dashboard ? this.dashboardUrl : false,
      devices: this.store.devices().length,
    });
    this.emit('listening', { url: this.url, port: this.opts.port });
    return this;
  }

  /**
   * Stops the hub, telling every device it was on purpose.
   *
   * Without the farewell, an ordinary deploy would look identical to a crash
   * and page whoever is on call - which is how people learn to ignore alarms.
   */
  async stop(reason = 'shutting down', expectedDowntimeMs = 0): Promise<void> {
    if (!this.started) return;
    this.started = false;

    if (this.beatTimer) clearInterval(this.beatTimer);
    this.beatTimer = undefined;

    for (const session of this.sessions.values()) {
      if (session.state !== 'ready') continue;
      session.send({ v: PROTOCOL_VERSION, t: 'bye', reason, expectedDowntimeMs });
    }

    this.calls.cancelAll();
    // Release anything flood control was still holding, rather than losing it.
    this.flood.flushAll();
    this.flood.stop();
    this.watchdog.stop();
    for (const timer of this.ackWaiters.values()) clearTimeout(timer);
    this.ackWaiters.clear();

    // Torn down here rather than left to each socket's close event. That
    // event arrives a tick later, by which time the map has been emptied and
    // `closeSession` returns at its `delete` guard - before releasing the
    // connection slot. The `Guard` is built once and outlives `stop()`, so
    // those phantom counts were still charged after the next `start()`: a hub
    // cycled a few times with devices connected refused the very devices it
    // had been holding, and the sweeper could never reclaim them.
    // Emptied before the loop, not after it. `closeSession` releases the slot -
    // which is why it is called here at all - but it also emits
    // `device:offline` when a device's last session goes, and a graceful
    // shutdown is not a device going offline. An application that pages on that
    // event would have been paged once per device on every deploy, which is the
    // false alarm the `bye` frame exists to prevent on the device side.
    this.byDevice.clear();
    for (const session of [...this.sessions.values()]) {
      session.close(1001, 'shutting down');
      this.closeSession(session);
    }
    this.sessions.clear();

    this.guard.stop();
    this.wss?.close();
    await new Promise<void>((res) => {
      if (!this.http) return res();
      this.http.close(() => res());
      // close() waits for keep-alive sockets; nudge the dashboard's along.
      this.http.closeAllConnections?.();
    });
    this.http = undefined;
    this.store.close();
  }

  /* ------------------------------------------------------------------ */
  /* Sending                                                             */
  /* ------------------------------------------------------------------ */

  /** Publishes a notification to every device whose role allows it. */
  async notify(input: NotifyInput | string): Promise<SentNotification> {
    const spec = typeof input === 'string' ? { title: input } : input;
    const n = this.buildNotification(spec);

    // Held back only when this key has already had its burst this window; the
    // count is released later as a single summary, so nothing is lost.
    if (this.flood.shouldCoalesce(n, spec.dedupeKey)) {
      this.metrics.coalescedOne();
      this.audit('notify.coalesced', { detail: { id: n.id, channel: n.channel } });
      return { ...n, reached: 0, deliveredTo: [], coalesced: true };
    }

    this.store.pushHistory(n);
    const deliveredTo = this.deliver(n);
    this.emit('notification', n);
    this.metrics.notified(n.severity, deliveredTo.length);
    this.audit('notify', {
      detail: {
        id: n.id,
        channel: n.channel,
        severity: n.severity,
        reached: deliveredTo.length,
      },
    });

    if (n.requireAck) this.scheduleAckRetry(n);
    void this.pushToOffline(n, deliveredTo);

    return { ...n, reached: deliveredTo.length, deliveredTo, coalesced: false };
  }

  debug(input: NotifyInput | string): Promise<SentNotification> {
    return this.notify(withSeverity(input, 'debug'));
  }
  info(input: NotifyInput | string): Promise<SentNotification> {
    return this.notify(withSeverity(input, 'info'));
  }
  success(input: NotifyInput | string): Promise<SentNotification> {
    return this.notify(withSeverity(input, 'success'));
  }
  warn(input: NotifyInput | string): Promise<SentNotification> {
    return this.notify(withSeverity(input, 'warning'));
  }
  error(input: NotifyInput | string): Promise<SentNotification> {
    return this.notify(withSeverity(input, 'error'));
  }
  critical(input: NotifyInput | string): Promise<SentNotification> {
    return this.notify(withSeverity(input, 'critical'));
  }

  /**
   * Rings the devices allowed to receive calls and reads `message` aloud on
   * whichever one answers. Resolves once the call reaches an outcome, so an
   * unanswered page can fall back to something else.
   */
  async call(input: CallInput | string): Promise<CallResult> {
    const req = this.buildCall(typeof input === 'string' ? { message: input } : input);
    const policy = req.policy ? this.store.policy(req.policy) : undefined;

    if (req.policy && !policy) {
      throw new Error(`unknown escalation policy: ${req.policy}`);
    }

    const steps = this.buildLadder(req, policy);
    const ringing = steps.flatMap((step) => step.targets.map((t) => t.deviceId));
    this.metrics.callPlaced();
    this.audit('call.placed', {
      detail: { id: req.id, steps: steps.length, targets: ringing.length, policy: req.policy },
    });

    if (ringing.length === 0) {
      this.opts.logger('call placed with no reachable device', { callId: req.id });
    }
    void this.pushCallToOffline(req, ringing);

    const result = await this.calls.place(req, steps, policy?.repeat ?? 0);
    this.metrics.callOutcome(result.outcome);
    return result;
  }

  /**
   * Turns a call request into an ordered ladder of rungs.
   *
   * A named policy wins; otherwise the historical shapes still apply, with
   * escalation meaning one device per rung and broadcast meaning all of them
   * on a single rung.
   */
  private buildLadder(req: CallRequest, policy: EscalationPolicy | undefined): CallStep[] {
    const defaultRing = req.ringSeconds ?? this.opts.defaultRingSeconds;

    if (policy) {
      return policy.steps.map((step) => ({
        targets: this.callTargets(req, step.to),
        ringSeconds: step.ringSeconds ?? defaultRing,
        delaySeconds: step.delaySeconds ?? 0,
      }));
    }

    const targets = this.callTargets(req);
    if (req.escalate === false) {
      return [{ targets, ringSeconds: defaultRing, delaySeconds: 0 }];
    }
    return targets.map((target) => ({
      targets: [target],
      ringSeconds: defaultRing,
      delaySeconds: 0,
    }));
  }

  private async pushCallToOffline(req: CallRequest, ringing: string[]): Promise<void> {
    if (!this.webPush.enabled) return;
    const online = new Set(ringing);
    const targets = this.store.devices().filter((device) => {
      if (!device.pushToken || device.status !== 'active' || online.has(device.id)) return false;
      if (snoozeHolds(device, req.severity)) return false;
      const role = this.store.role(device.role);
      if (!role) return false;
      return canDeliver({
        role,
        deviceId: device.id,
        channel: req.channel,
        severity: req.severity,
        to: req.to,
        isCall: true,
      });
    });

    await this.webPush.send(webPushTargets(targets), {
      title: `Incoming alert from ${req.from}`,
      body: this.opts.webPush.includeBody ? req.message : 'Open to answer',
      tag: req.id,
      severity: req.severity,
    });
  }

  private beat(): void {
    const ts = Date.now();
    for (const session of this.sessions.values()) {
      if (session.state !== 'ready') continue;
      session.send({ v: PROTOCOL_VERSION, t: 'beat', ts });
    }
  }

  /**
   * Drops sockets that are open but no longer reachable.
   *
   * Nothing else does this. A session is removed on `close` or `error`, and a
   * half-open connection produces neither: the hub goes on believing the device
   * is here for as long as TCP takes to give up, which is many minutes and on a
   * quiet socket can be never. Until then it is counted in `reached` - so the
   * hub reports alerts as delivered to somebody who is not there - and an
   * escalating call spends a full rung ringing it before moving on.
   *
   * One missed pong is enough. The interval is generous relative to a round
   * trip, and the cost of being wrong is a reconnect the client performs
   * automatically, against the cost of a page nobody hears.
   */
  private sweepDeadSockets(): void {
    for (const session of [...this.sessions.values()]) {
      // A session still in the handshake has its own, much shorter, deadline.
      if (session.state !== 'ready') continue;

      if (!session.alive) {
        this.metrics.dropped();
        this.audit('session.unreachable', {
          ip: session.ip,
          deviceId: session.deviceId,
        });
        this.opts.logger('dropped a device that stopped answering', {
          device: session.deviceName,
        });
        session.destroy();
        continue;
      }

      session.alive = false;
      session.ping();
    }
  }

  cancelCall(callId: string): boolean {
    return this.calls.cancel(callId);
  }

  /* ------------------------------------------------------------------ */
  /* Pairing, devices, roles                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Mints a single-use pairing code for a role. The plaintext is returned once
   * and never stored - only its hash goes to disk, so a leaked store file
   * cannot be used to pair a new device.
   */
  createPairingCode(input: PairingCodeInput = {}): IssuedPairingCode {
    const roleName = input.role ?? 'viewer';
    const role = this.store.role(roleName);
    if (!role) throw new Error(`unknown role: ${roleName}`);

    const code = encodePairingCode(nodeCrypto.randomBytes(7));
    // `pair.create` is reachable over the wire, so its arguments are bounded
    // here rather than trusted. A code's whole safety argument rests on it
    // being short-lived and nearly single-use.
    const ttlMs = clampNumber(input.ttlMs, 1_000, MAX_CODE_TTL_MS, 10 * 60_000);
    const expiresAt = Date.now() + ttlMs;
    this.store.putCode({
      hash: pairingCodeHash(code),
      role: roleName,
      createdAt: Date.now(),
      expiresAt,
      usesLeft: clampNumber(input.uses, 1, MAX_CODE_USES, 1),
      // Compiled and discarded, purely to refuse a restriction nobody could
      // satisfy while the person minting the code is still looking at the
      // answer. A code restricted to an address that is not one cannot be
      // redeemed by anybody, and at redemption time there is no one to tell.
      allowIps: Array.isArray(input.allowIps)
        ? ((list) => {
            compileIpList('pairing code allowIps', list);
            return list;
          })(input.allowIps.filter((ip) => typeof ip === 'string').slice(0, 50))
        : undefined,
      // Through the same filter as a name: a label is printed by `notifyjs token
      // list` and by the dashboard.
      label: input.label === undefined ? undefined : sanitizeName(input.label),
    });
    this.audit('pair.created', { detail: { role: roleName, expiresAt } });

    const link = buildPairingLink(this.publicUrl, code);
    return { code, role: roleName, expiresAt, link, qr: renderQr(link) };
  }

  /**
   * The address a device on the network should use to reach this hub.
   *
   * `this.url` reports localhost when bound to 0.0.0.0, which is useless in a
   * pairing link a phone has to follow, so fall back to the machine's first
   * non-internal IPv4 address.
   */
  get publicUrl(): string {
    if (this.opts.publicUrl) return this.opts.publicUrl;
    if (this.opts.host !== '0.0.0.0' && this.opts.host !== '::') return this.url;

    const scheme = this.opts.tls ? 'wss' : 'ws';
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family === 'IPv4' && !entry.internal) {
          return `${scheme}://${entry.address}:${this.opts.port}`;
        }
      }
    }
    return this.url;
  }

  pairingCodes() {
    return this.store.codes();
  }

  revokePairingCode(hash: string): boolean {
    return this.store.revokeCode(hash);
  }

  devices(): Device[] {
    return this.store.devices();
  }

  onlineDeviceIds(): string[] {
    return [...this.byDevice.keys()];
  }

  /** Revokes a device and disconnects it. Its keypair becomes worthless. */
  revokeDevice(deviceId: string): boolean {
    const device = this.store.updateDevice(deviceId, { status: 'revoked' });
    if (!device) return false;
    for (const session of this.byDevice.get(deviceId) ?? []) {
      session.send({ v: PROTOCOL_VERSION, t: 'revoked', reason: 'revoked by operator' });
      session.close(4003, 'revoked');
    }
    this.audit('device.revoked', { deviceId });
    this.emit('device:revoked', device);
    return true;
  }

  deleteDevice(deviceId: string): boolean {
    this.revokeDevice(deviceId);
    return this.store.deleteDevice(deviceId);
  }

  renameDevice(deviceId: string, name: string): Device | undefined {
    // Same treatment a name gets at pairing time. `devices.rename` is reachable
    // over the wire, and the result lands in dashboards, logs and an operator's
    // terminal - so a rename must not be the one way in for an escape sequence
    // that `pair` already refuses.
    const clean = sanitizeName(name);
    if (!clean) return undefined;
    const updated = this.store.updateDevice(deviceId, { name: clean });
    if (updated) {
      // Refreshed on live sessions, exactly as a role change is. Without it the
      // old name went on being used until the device reconnected - and it is the
      // name that appears in a call's result, in the `action` event, and in the
      // lines logged when a device is dropped for not reading its socket.
      for (const session of this.byDevice.get(deviceId) ?? []) session.device = updated;
    }
    return updated;
  }

  setDeviceRole(deviceId: string, role: string): Device | undefined {
    if (!this.store.role(role)) throw new Error(`unknown role: ${role}`);
    const updated = this.store.updateDevice(deviceId, { role });
    if (updated) {
      // Refresh live sessions so the change takes effect without a reconnect.
      for (const session of this.byDevice.get(deviceId) ?? []) {
        session.device = updated;
        session.role = this.store.role(role);
      }
      this.audit('device.role', { deviceId, detail: { role } });
    }
    return updated;
  }

  roles(): Role[] {
    return this.store.roles();
  }

  upsertRole(role: Role): void {
    this.store.putRole(role);
    for (const session of this.sessions.values()) {
      if (session.device?.role === role.name) session.role = role;
    }
  }

  deleteRole(name: string): boolean {
    if (this.store.devices().some((d) => d.role === name && d.status === 'active')) {
      throw new Error(`role ${name} still has active devices`);
    }
    return this.store.deleteRole(name);
  }

  history(): Notification[] {
    return this.store.history();
  }

  auditLog(limit = 100): AuditEvent[] {
    return this.store.auditTail(limit);
  }

  /* ------------------------------------------------------------------ */
  /* HTTP + upgrade                                                      */
  /* ------------------------------------------------------------------ */

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // A locked-down policy is affordable here because the dashboard ships as
    // same-origin ES modules with no third-party assets at all.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );

    // The operator's allow and deny lists, and any ban, apply to this port as a
    // whole - not only to the WebSocket upgrade and the HTTP publish, which were
    // the only two paths that consulted the guard. A hub locked to one subnet
    // still served `/hub.json`, `/metrics` and the entire dashboard to anybody who
    // asked, and a banned address kept all of that too: everything an attacker
    // wants for reconnaissance, including a metrics endpoint that reports how their
    // own attempt is going.
    // The publish endpoints check the guard themselves and answer in their own
    // shape - deliberately not distinguishing a ban from a deny list, so a caller
    // cannot tell which it tripped - so they are left to it.
    const publishing = url.pathname === '/api/notify' || url.pathname === '/api/call';
    const ip = this.clientIp(req);
    if (!publishing && this.guard.refused(ip)) {
      this.audit('http.refused', { ip, detail: { path: url.pathname } });
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Forbidden\n');
      return;
    }
    const banned = publishing ? 0 : this.guard.bannedFor(ip);
    if (banned > 0) {
      res.writeHead(429, {
        'content-type': 'text/plain',
        'retry-after': String(Math.ceil(banned / 1000)),
      });
      res.end('Too Many Requests\n');
      return;
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: this.opts.name, protocol: PROTOCOL_VERSION }));
      return;
    }

    // Lets a device confirm which hub it is about to trust before pairing.
    if (url.pathname === '/hub.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          name: this.opts.name,
          serverId: this.store.serverId,
          protocol: PROTOCOL_VERSION,
          // Lets the dashboard notice the hub was upgraded underneath it and
          // offer a reload, rather than running stale assets indefinitely.
          version: NOTIFYJS_VERSION,
          ws: this.url,
        }),
      );
      return;
    }

    if (url.pathname === '/metrics') {
      if (!this.opts.metrics) {
        res.writeHead(404).end();
        return;
      }
      // Counts only, never alert content - but still worth a token when the
      // port is public.
      //
      // Compared in constant time: `!==` on a secret returns as soon as two
      // characters differ, and that timing difference is enough to recover the
      // token one character at a time from an endpoint an attacker can poll.
      const token = this.opts.metricsToken;
      if (token) {
        const offered = req.headers.authorization;
        if (typeof offered !== 'string' || !timingSafeEqual(offered, `Bearer ${token}`)) {
          res.writeHead(401, { 'www-authenticate': 'Bearer' }).end();
          return;
        }
      }
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(this.renderMetrics());
      return;
    }

    if (url.pathname === '/api/notify' || url.pathname === '/api/call') {
      await this.handleIngest(req, res, url.pathname === '/api/call' ? 'call' : 'notify');
      return;
    }

    if (!this.dashboardRoot) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('dashboard disabled');
      return;
    }
    await this.serveStatic(this.dashboardRoot, url.pathname, res);
  }

  private renderMetrics(): string {
    const beats = this.watchdog.list();
    return this.metrics.render({
      devices: this.store.devices().length,
      devicesOnline: this.byDevice.size,
      sessions: this.sessions.size,
      heartbeats: beats.length,
      heartbeatsMissing: beats.filter((b) => b.missing).length,
      activeCalls: this.calls.activeCount,
    });
  }

  private async serveStatic(root: string, pathname: string, res: ServerResponse): Promise<void> {
    const rel = pathname === '/' ? '/index.html' : pathname;
    // normalize() collapses `..` so a crafted path cannot escape the root; the
    // startsWith check is the belt to that suspenders.
    const target = resolvePath(join(root, normalize(rel)));
    if (!target.startsWith(resolvePath(root))) {
      res.writeHead(403).end();
      return;
    }

    try {
      const info = await stat(target);
      if (!info.isFile()) throw new Error('not a file');
      const body = await readFile(target);
      res.writeHead(200, {
        // Lowercased: a file served as `LOGO.PNG` is still a PNG, and a browser
        // handed `application/octet-stream` under `nosniff` will not render it.
        'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const ip = this.clientIp(req);
    const origin = req.headers.origin;

    if (!this.originAllowed(origin, req.headers.host)) {
      this.audit('upgrade.origin_rejected', { ip, detail: { origin } });
      return refuse(socket, 403, 'Forbidden');
    }

    const verdict = this.guard.admit(ip);
    if (!verdict.ok) {
      this.audit('upgrade.rejected', { ip, detail: { reason: verdict.reason } });
      if (verdict.reason === 'banned' || verdict.reason === 'rate_limited') {
        this.emit('auth:failed', { ip, reason: verdict.reason });
      }
      return refuse(socket, 429, 'Too Many Requests', verdict.retryAfter);
    }

    // A handshake `ws` abandons never reaches this callback: no
    // `Sec-WebSocket-Key`, a version it does not speak, an unparseable
    // extension header. Node has emitted `upgrade` by then and `admit()` above
    // has already charged a slot, so without releasing it here the count is
    // held by a session that never existed - `closeSession` is the only other
    // caller of `release()`, and the sweeper keeps any address whose count is
    // not zero. A hundred such requests answer every honest device with 429,
    // for the life of the process.
    //
    // The flag is enough because `ws` completes an upgrade synchronously in
    // this configuration - `noServer`, and no `verifyClient` to defer on.
    let opened = false;
    this.wss!.handleUpgrade(req, socket, head, (ws) => {
      opened = true;
      this.openSession(ws, ip, origin);
    });
    if (!opened) this.guard.release(ip, false);
  }

  /**
   * Browsers attach an Origin to cross-site WebSocket attempts, so this is
   * what stops a page you happen to visit from probing a hub on your network.
   * Non-browser clients send no Origin and are always allowed through - they
   * still have to authenticate.
   */
  private originAllowed(origin: string | undefined, host: string | undefined): boolean {
    const allowed = this.opts.security.allowedOrigins;
    if (allowed === '*' || !origin) return true;

    if (Array.isArray(allowed)) return allowed.includes(origin);

    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* HTTP ingest                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Publishing without speaking the protocol.
   *
   * The hub's own clients sign a per-connection nonce, which is a better
   * credential than anything that fits in a header. This exists because the
   * things most worth being paged by - a monitoring system, a CI job, a cron
   * line - will never implement that handshake, and a pager nothing can reach
   * is not a pager.
   *
   * The checks that guard a socket apply here too: the allow/deny lists and
   * the ban list run first, a bad token is charged toward a ban, the token
   * resolves to a role, and the role decides what may be published. What is *not* shared is the trust: this path is off
   * until enabled, and refuses a cleartext connection from off-box outright.
   */
  private async handleIngest(
    req: IncomingMessage,
    res: ServerResponse,
    kind: 'notify' | 'call',
  ): Promise<void> {
    const send = (code: number, body: Record<string, unknown>) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (!this.opts.ingest.enabled) {
      // 404 rather than 403: a disabled feature should not confirm it exists.
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }

    if (req.method !== 'POST') {
      send(405, { error: 'method_not_allowed', message: 'POST a JSON body' });
      return;
    }

    const startedAt = Date.now();
    const ip = this.clientIp(req);
    // The operator's allow/deny lists say "connect at all", and until this was
    // checked here a hub locked to its LAN still took tokens from anywhere.
    if (this.guard.refused(ip)) {
      send(403, { error: 'denied', message: 'this address is refused' });
      return;
    }
    if (this.guard.bannedFor(ip) > 0) {
      send(403, { error: 'banned', message: 'this address is refused' });
      return;
    }

    // A bearer token on a cleartext link off-box is readable by every hop it
    // crosses. Loopback is exempt because there is no hop, which is what makes
    // a hub behind a local reverse proxy workable without weakening this.
    //
    // Decided from the socket's own address, never from `clientIp()`. That
    // helper honours `X-Forwarded-For` when `trustProxy` is set, and that
    // header is written by the caller - so deriving "is this request on-box"
    // from it lets a remote caller answer the question itself and skip the
    // very refusal this is. Worse, it filters the wrong population: behind the
    // reverse proxy this exemption exists for, an honest client forwards its
    // real address and is refused, while anyone adding
    // `X-Forwarded-For: 127.0.0.1` is waved through.
    const peer = normalizeIp(req.socket.remoteAddress ?? undefined);
    if (!this.opts.tls && !this.opts.ingest.allowInsecure && !isLoopback(peer)) {
      send(421, {
        error: 'insecure_transport',
        message: 'refusing a bearer token over plain HTTP; use wss/TLS or set ingest.allowInsecure',
      });
      return;
    }

    const offered = bearerFrom(req.headers.authorization);
    if (!offered) {
      res.setHeader('www-authenticate', 'Bearer');
      send(401, { error: 'unauthenticated', message: 'Authorization: Bearer <token>' });
      return;
    }

    const token = findIngestToken(this.store.ingestTokens(), offered);
    if (!token) {
      // Charged against the IP exactly like a failed handshake, so guessing
      // tokens over HTTP runs into the same wall as guessing them over a
      // socket rather than being an unmetered oracle.
      this.guard.fail(ip);
      // Same floor a failed handshake gets, so a wrong token and an unknown one
      // take indistinguishable time to be refused.
      await uniformDelay(startedAt, this.opts.security.uniformFailureMs);
      res.setHeader('www-authenticate', 'Bearer');
      send(401, { error: 'unauthenticated', message: 'unknown or revoked token' });
      return;
    }

    // A valid token clears the failure counter, exactly as a completed
    // handshake does. Charging failures without ever crediting a success was
    // the asymmetry: a publisher with proven-valid credentials went on
    // accumulating toward a ban, and a ban here is the same ban the WebSocket
    // handshake honours - so a script left running with a stale token could
    // lock out a phone that merely shares its NAT.
    this.guard.succeed(ip);

    if (!this.ingestLimiter(token.id).allow()) {
      send(429, { error: 'rate_limited', message: 'too many requests for this token' });
      return;
    }

    const role = this.store.role(token.role);
    const needed: Capability = kind === 'call' ? 'call.place' : 'notify.send';
    if (!tokenMay(role, needed)) {
      this.audit('ingest.forbidden', { detail: { token: token.id, kind } });
      send(403, { error: 'forbidden', message: `role '${token.role}' cannot ${needed}` });
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req, this.opts.ingest.maxBodyBytes);
    } catch (err) {
      const tooLarge = err instanceof Error && err.message === 'too_large';
      if (tooLarge) {
        // The peer is still sending, and nothing here will read the rest of
        // it. Saying so lets the connection end cleanly after the response
        // rather than being reset underneath it.
        res.setHeader('connection', 'close');
      }
      send(tooLarge ? 413 : 400, {
        error: tooLarge ? 'payload_too_large' : 'bad_request',
        message: tooLarge ? 'body exceeds the configured limit' : 'body must be a JSON object',
      });
      if (tooLarge) res.once('finish', () => req.destroy());
      return;
    }

    // Recorded coarsely, and deliberately.
    //
    // Every write here marks the store dirty, and a dirty store is rewritten
    // whole - which is the exact cost this project already went out of its way
    // to remove from the notification path, where it made sending one alert
    // proportional to everything ever sent. An ingest token is the busiest
    // publisher a hub has, so stamping it per request would put that cost back
    // on the hottest path in the system. Minute resolution is no worse an
    // answer to "when was this last used" and takes the write out of the loop.
    const lastUsed = token.lastUsedAt ?? 0;
    if (Date.now() - lastUsed > INGEST_LAST_USED_RESOLUTION_MS) {
      this.store.updateIngestToken(token.id, { lastUsedAt: Date.now() });
    }

    try {
      if (kind === 'call') {
        const message = typeof body.message === 'string' ? body.message : '';
        if (!message) {
          send(400, { error: 'bad_request', message: 'call requires a message' });
          return;
        }
        // Held open for the whole ring, which is what makes the outcome worth
        // having: the caller learns whether a person actually answered rather
        // than only that the hub accepted the request. Bounded by the call's
        // own `ringSeconds` and its escalation ladder, so a client posting
        // here wants a generous read timeout.
        const result = await this.call({
          message,
          from: typeof body.from === 'string' ? body.from : `token:${token.label ?? token.id}`,
          channel: typeof body.channel === 'string' ? body.channel : undefined,
          severity: coerceSeverity(body.severity, 'critical'),
          policy: typeof body.policy === 'string' ? body.policy : undefined,
        });
        this.audit('ingest.call', {
          detail: { token: token.id, id: result.callId, outcome: result.outcome },
        });
        send(200, {
          ok: true,
          callId: result.callId,
          outcome: result.outcome,
          deviceName: result.deviceName,
          attempted: result.attempted.length,
        });
        return;
      }

      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (!title) {
        send(400, { error: 'bad_request', message: 'notify requires a title' });
        return;
      }

      // Built field by field rather than spread: the body is attacker-shaped,
      // and spreading it would let a caller set fields this endpoint has no
      // business exposing - `seq` and `ts` among them, which decide replay
      // ordering for every device.
      const result = await this.notify({
        title,
        body: typeof body.body === 'string' ? body.body : undefined,
        channel: typeof body.channel === 'string' ? body.channel : undefined,
        severity: coerceSeverity(body.severity, 'info'),
        tags: Array.isArray(body.tags)
          ? body.tags.filter((t): t is string => typeof t === 'string').slice(0, 20)
          : undefined,
        data: isPlainObject(body.data) ? body.data : undefined,
        requireAck: body.requireAck === true,
        ttl: typeof body.ttl === 'number' && Number.isFinite(body.ttl) ? body.ttl : undefined,
        dedupeKey: typeof body.dedupeKey === 'string' ? body.dedupeKey : undefined,
        resolveKey: typeof body.resolveKey === 'string' ? body.resolveKey : undefined,
      });

      this.audit('ingest.notify', {
        detail: { token: token.id, id: result.id, channel: result.channel },
      });
      send(202, {
        ok: true,
        id: result.id,
        seq: result.seq,
        reached: result.reached,
        coalesced: result.coalesced === true,
      });
    } catch (err) {
      this.opts.logger('an ingested request could not be published', {
        error: err instanceof Error ? err.message : String(err),
      });
      send(400, { error: 'rejected', message: err instanceof Error ? err.message : 'rejected' });
    }
  }

  /**
   * One limiter per token, created on first use.
   *
   * Keyed on the token rather than the IP: a CI runner publishes from a
   * different address on every job, and a shared NAT would otherwise have one
   * noisy publisher throttle everybody behind it.
   */
  private ingestLimiter(id: string): MessageLimiter {
    let limiter = this.ingestLimiters.get(id);
    if (!limiter) {
      limiter = new MessageLimiter(this.opts.ingest.ratePerMinute, 60_000);
      this.ingestLimiters.set(id, limiter);
    }
    return limiter;
  }

  /**
   * Mints a token. The plaintext is returned exactly once - only its hash is
   * kept - so a caller that does not record it has to issue another.
   */
  createIngestToken(input: { role: string; label?: string }): { id: string; token: string } {
    if (!this.store.role(input.role)) throw new Error(`unknown role: ${input.role}`);
    const { id, token, hash } = mintIngestToken();
    this.store.addIngestToken({
      id,
      hash,
      role: input.role,
      // Filtered here, where every caller passes through - the admin path filtered
      // its own copy and an embedding application's did not, and this label is
      // printed by `notifyjs token list`, where an escape sequence can redraw the
      // row above and make a live token look like a revoked one.
      label: input.label === undefined ? undefined : sanitizeMessage(input.label, 120) || undefined,
      createdAt: Date.now(),
    });
    this.audit('ingest.token.created', { detail: { token: id, role: input.role } });
    return { id, token };
  }

  /** Revokes a token. Kept, not deleted, so the audit trail still resolves. */
  revokeIngestToken(id: string): boolean {
    const existing = this.store.ingestToken(id);
    if (!existing || existing.revokedAt) return false;
    this.store.updateIngestToken(id, { revokedAt: Date.now() });
    this.ingestLimiters.delete(id);
    this.audit('ingest.token.revoked', { detail: { token: id } });
    return true;
  }

  /** Tokens, without their hashes - there is nothing useful in a hash here. */
  ingestTokens(): Array<Omit<IngestToken, 'hash'>> {
    return this.store.ingestTokens().map(({ hash: _hash, ...rest }) => rest);
  }

  private clientIp(req: IncomingMessage): string {
    if (this.opts.security.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      const chain = Array.isArray(fwd) ? fwd.join(',') : fwd;
      // The last entry, never the first. A proxy appends the address it saw to
      // whatever the client already sent, so every entry before the last was
      // written by the client. Reading the first let a peer going through the
      // very proxy this option exists for name a fresh identity per request -
      // past the rate limit and every ban - or name someone else's address and
      // get it banned.
      const last = chain?.split(',').pop();
      // Only an actual address is honoured. The header is client-supplied, so
      // an unvalidated value lets a peer invent a new identity per request and
      // walk straight past the per-IP rate limit and every ban ever issued.
      const candidate = last ? normalizeIp(last.trim()) : undefined;
      if (candidate && isIpAddress(candidate)) return candidate;
    }
    return normalizeIp(req.socket.remoteAddress ?? undefined);
  }

  /* ------------------------------------------------------------------ */
  /* Session handling                                                    */
  /* ------------------------------------------------------------------ */

  private openSession(ws: WebSocket, ip: string, origin: string | undefined): void {
    const session = new Session(
      randomId(8),
      ws,
      ip,
      origin,
      this.opts.security.messageRate,
      this.opts.security.maxBufferedBytes,
    );
    session.nonce = toBase64Url(nodeCrypto.randomBytes(32));
    this.sessions.set(session.id, session);

    session.handshakeTimer = setTimeout(() => {
      if (session.state === 'handshake') {
        this.audit('handshake.timeout', { ip });
        session.close(4008, 'handshake timeout');
      }
    }, this.opts.security.handshakeTimeoutMs);
    session.handshakeTimer.unref?.();

    session.send({
      v: PROTOCOL_VERSION,
      t: 'hello',
      serverId: this.store.serverId,
      serverName: this.opts.name,
      nonce: session.nonce,
      serverTime: Date.now(),
      handshakeTimeout: Math.floor(this.opts.security.handshakeTimeoutMs / 1000),
      // Ask for proof of life on the same cadence the hub already sweeps on,
      // so a device's silence and the hub's next look at it line up.
      keepaliveMs: this.opts.livenessIntervalMs,
    });

    ws.on('message', (raw, isBinary) => {
      this.handleMessage(session, raw as Buffer, isBinary).catch((err) => {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
        session.close(1011, 'internal error');
      });
    });
    // The peer's implementation answers pings for it, so a pong is proof the
    // far end is still reachable rather than proof its app is healthy - which
    // is exactly the question `sweepDeadSockets` asks.
    ws.on('pong', () => {
      session.alive = true;
      // Presence, not intent: the peer's implementation sent this, so it says
      // the device is reachable and nothing about anyone using it.
      this.touchDevice(session, false);
    });
    ws.on('close', () => this.closeSession(session));
    ws.on('error', () => this.closeSession(session));
  }

  private closeSession(session: Session): void {
    if (!this.sessions.delete(session.id)) return;
    session.clearHandshakeTimer();
    session.state = 'closed';
    this.guard.release(session.ip, session.promoted);

    if (session.stalled) {
      this.metrics.stalled();
      this.audit('session.stalled', { ip: session.ip, deviceId: session.deviceId });
      this.opts.logger('dropped a device that stopped reading its socket', {
        device: session.deviceName,
      });
    }

    const deviceId = session.deviceId;
    if (deviceId) {
      const set = this.byDevice.get(deviceId);
      set?.delete(session);
      if (set && set.size === 0) {
        this.byDevice.delete(deviceId);
        this.calls.dropped(deviceId);
        const device = this.store.device(deviceId);
        if (device) this.emit('device:offline', device);
      }
    }
  }

  /**
   * Records that a device was heard from.
   *
   * `lastSeenAt` used to be written only at pair and auth, so it meant "when
   * this device connected" while claiming to mean "when it was last seen" -
   * which made `notifyjs devices` print `online ... 7 days ago` for a device
   * connected right now.
   *
   * Written through a throttle because it is on the path of every inbound
   * frame, and a store write per frame would make the busiest device the most
   * expensive one.
   */
  private touchDevice(session: Session, active: boolean): void {
    const device = session.device;
    if (!device) return;

    const now = Date.now();
    const patch: Partial<Device> = {};
    if (now - (device.lastSeenAt ?? 0) >= DEVICE_TOUCH_MS) patch.lastSeenAt = now;
    if (active && now - (device.lastActiveAt ?? 0) >= DEVICE_TOUCH_MS) patch.lastActiveAt = now;
    if (Object.keys(patch).length === 0) return;

    const updated = this.store.updateDevice(device.id, patch);
    if (updated) {
      for (const other of this.byDevice.get(device.id) ?? []) other.device = updated;
    }
  }

  private async handleMessage(session: Session, raw: Buffer, isBinary: boolean): Promise<void> {
    if (session.state === 'closed') return;
    if (isBinary || raw.length > this.opts.security.maxMessageBytes) {
      this.audit('frame.rejected', { ip: session.ip, detail: { bytes: raw.length, isBinary } });
      session.destroy();
      return;
    }
    if (!session.limiter.allow()) {
      session.error('rate_limited', 'too many messages');
      session.destroy();
      return;
    }

    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString('utf8')) as ClientMessage;
    } catch {
      session.error('bad_request', 'malformed frame');
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') {
      session.error('bad_request', 'missing type');
      return;
    }

    if (session.state === 'handshake') {
      if (msg.t === 'pair') return this.handlePair(session, msg);
      if (msg.t === 'auth') return this.handleAuth(session, msg);
      session.error('unauthenticated', 'pair or auth first');
      return;
    }

    // Written by the peer's own code, unlike a pong, so this is the timestamp
    // that says the far end is still processing rather than merely connected.
    session.appSeenAt = Date.now();
    if (msg.t === 'ping') session.keepalives = true;

    // `ping` is a keepalive and says nothing about intent; everything else
    // here is the device or its user doing something.
    this.touchDevice(session, msg.t !== 'ping');

    switch (msg.t) {
      case 'ack':
        return this.handleAck(session, msg);
      case 'sync':
        return this.handleSync(session, msg);
      case 'call.reply':
        // Answering, declining and hanging up all steer a live call, so they
        // are gated on the capability that makes a device part of one. A
        // device that never rings has no business deciding how a page ends.
        if (!this.canAnswerCalls(session)) return;
        if (msg.outcome === 'answered') this.calls.answer(msg.callId, session.deviceId!);
        else this.calls.decline(msg.callId, session.deviceId!);
        return;
      case 'call.ended':
        if (!this.canAnswerCalls(session)) return;
        this.calls.ended(msg.callId, session.deviceId!);
        return;
      case 'admin':
        return await this.handleAdmin(session, msg);
      case 'push.register':
        return this.handlePushRegister(session, msg);
      case 'snooze':
        return this.handleSnooze(session, msg);
      case 'ping':
        session.send({ v: PROTOCOL_VERSION, t: 'pong', ts: Date.now() });
        return;
      default:
        // Forward compatibility: a newer client may send frames we predate.
        return;
    }
  }

  /* ---------------------------- handshake ---------------------------- */

  private async handlePair(
    session: Session,
    msg: Extract<ClientMessage, { t: 'pair' }>,
  ): Promise<void> {
    const startedAt = Date.now();
    const nonce = session.takeNonce();

    const fail = async (reason: string) => {
      // Every rejection returns the same code and takes the same time. An
      // attacker learns only "no", never "close" - which is what makes
      // guessing a 50-bit code against a 5-strike lockout hopeless.
      await uniformDelay(startedAt, this.opts.security.uniformFailureMs);
      const { banned, until } = this.guard.fail(session.ip);
      this.audit('pair.failed', { ip: session.ip, detail: { reason } });
      this.emit('auth:failed', { ip: session.ip, reason });
      this.metrics.authFailed();
      if (banned) {
        this.metrics.banned();
        this.emit('banned', { ip: session.ip, until });
        this.opts.logger('banned ip after repeated failures', { ip: session.ip, until });
      }
      session.error('pair_failed', 'pairing failed');
      session.close(4001, 'pair failed');
    };

    if (!nonce) return fail('nonce_spent');
    if (typeof msg.code !== 'string' || !isPairingCodeValid(msg.code)) return fail('malformed_code');
    if (typeof msg.publicKey !== 'string' || msg.publicKey.length !== 43) return fail('bad_key');

    const normalized = normalizePairingCode(msg.code);
    // Reserved, not just read: signature verification below is asynchronous,
    // and two sockets redeeming the same single-use code would otherwise both
    // pass this check before either consumed it, enrolling two devices.
    const record = this.store.reserveCode(normalized);
    if (!record) return fail('unknown_code');

    // Anything that rejects the attempt from here on has to hand the use back,
    // or a mistyped IP allowlist would silently burn the operator's code.
    const release = () => this.store.releaseCode(record.hash);
    const rejectAndRelease = (reason: string) => {
      release();
      return fail(reason);
    };

    // Through the same matcher as the hub-wide lists, so a range works here
    // too. This was an exact-string `includes`, which meant a code restricted to
    // `10.0.0.0/24` could be redeemed by nobody at all - and the restriction
    // refuses anything unlisted, so the code was simply unusable.
    if (record.allowIps) {
      let allowed;
      try {
        allowed = compileIpList('pairing code allowIps', record.allowIps);
      } catch {
        // A restriction that cannot be read is not one anybody may redeem
        // against: "only these addresses" has to fail closed, and a code stored
        // by an older build could hold anything.
        return rejectAndRelease('ip_not_allowed');
      }
      if (allowed && !matchesIp(allowed, session.ip)) {
        return rejectAndRelease('ip_not_allowed');
      }
    }

    const role = this.store.role(record.role);
    if (!role) return rejectAndRelease('unknown_role');

    if (role.maxDevices !== undefined) {
      const count = this.store
        .devices()
        .filter((d) => d.role === role.name && d.status === 'active').length;
      if (count >= role.maxDevices) return rejectAndRelease('role_full');
    }

    // The signature binds the public key to *this* connection's nonce, so a
    // captured pair frame cannot be replayed to enrol an attacker's key.
    const transcript = canonical([
      SIG_PAIR,
      this.store.serverId,
      nonce,
      normalized,
      msg.publicKey,
      String(msg.name ?? ''),
      String(msg.platform ?? ''),
    ]);
    if (!(await nodeCrypto.verify(msg.publicKey, transcript, String(msg.sig ?? '')))) {
      return rejectAndRelease('bad_signature');
    }

    if (this.store.deviceByPublicKey(msg.publicKey)) return rejectAndRelease('key_in_use');

    const device: Device = {
      id: randomId(12),
      name: sanitizeName(msg.name) || 'device',
      role: role.name,
      publicKey: msg.publicKey,
      platform: sanitizeName(msg.platform) || 'unknown',
      model: msg.model ? sanitizeName(msg.model) : undefined,
      status: 'active',
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      lastActiveAt: Date.now(),
      lastIp: session.ip,
      // Start at the current head: a new device gets what happens next, not a
      // replay of every incident from before it existed.
      ackedSeq: this.store.seq,
    };
    this.store.putDevice(device);
    this.guard.succeed(session.ip);

    this.audit('pair.success', {
      ip: session.ip,
      deviceId: device.id,
      detail: { role: role.name },
    });
    this.opts.logger('device paired', { name: device.name, role: role.name, id: device.id });
    this.emit('device:paired', device);

    session.send({
      v: PROTOCOL_VERSION,
      t: 'paired',
      deviceId: device.id,
      role: role.name,
      capabilities: role.capabilities,
    });
    this.promote(session, device, role);
  }

  private async handleAuth(
    session: Session,
    msg: Extract<ClientMessage, { t: 'auth' }>,
  ): Promise<void> {
    const startedAt = Date.now();
    const nonce = session.takeNonce();

    const fail = async (reason: string) => {
      await uniformDelay(startedAt, this.opts.security.uniformFailureMs);
      const { banned, until } = this.guard.fail(session.ip);
      this.audit('auth.failed', { ip: session.ip, detail: { reason } });
      this.emit('auth:failed', { ip: session.ip, reason });
      this.metrics.authFailed();
      if (banned) {
        this.metrics.banned();
        this.emit('banned', { ip: session.ip, until });
      }
      session.error('auth_failed', 'authentication failed');
      session.close(4001, 'auth failed');
    };

    if (!nonce) return fail('nonce_spent');
    if (typeof msg.deviceId !== 'string' || typeof msg.sig !== 'string') return fail('malformed');

    const skew = Math.abs(Date.now() - Number(msg.ts));
    if (!Number.isFinite(skew) || skew > this.opts.security.clockSkewMs) return fail('clock_skew');

    const device = this.store.device(msg.deviceId);
    // Verifying against a throwaway key on unknown devices keeps the timing of
    // "no such device" indistinguishable from "wrong signature".
    const publicKey = device?.publicKey ?? DECOY_PUBLIC_KEY;
    const transcript = canonical([
      SIG_AUTH,
      this.store.serverId,
      msg.deviceId,
      nonce,
      String(msg.ts),
    ]);
    const signatureOk = await nodeCrypto.verify(publicKey, transcript, msg.sig);

    if (!device || device.status !== 'active') return fail('unknown_device');
    if (!signatureOk) return fail('bad_signature');

    const role = this.store.role(device.role);
    if (!role) return fail('role_missing');

    this.guard.succeed(session.ip);
    const updated =
      this.store.updateDevice(device.id, { lastSeenAt: Date.now(), lastIp: session.ip }) ?? device;
    this.audit('auth.success', { ip: session.ip, deviceId: device.id });
    this.promote(session, updated, role);
  }

  /** Moves a session into the authenticated set and flushes anything missed. */
  private promote(session: Session, device: Device, role: Role): void {
    session.clearHandshakeTimer();
    session.state = 'ready';
    session.device = device;
    session.role = role;
    if (!session.promoted) {
      session.promoted = true;
      this.guard.promote();
    }

    let set = this.byDevice.get(device.id);
    if (!set) {
      set = new Set();
      this.byDevice.set(device.id, set);
      this.emit('device:online', device);
    }
    set.add(session);

    session.send({
      v: PROTOCOL_VERSION,
      t: 'ready',
      deviceId: device.id,
      deviceName: device.name,
      role: role.name,
      capabilities: role.capabilities,
      seq: this.store.seq,
      serverTime: Date.now(),
      // Only while it is still running: an expired one is not news.
      snoozedUntil:
        device.snoozedUntil && device.snoozedUntil > Date.now() ? device.snoozedUntil : undefined,
      // Minted on first use, so a hub with Web Push off never generates one.
      vapidPublicKey: this.opts.webPush.enabled
        ? this.store.vapid(generateVapidKeys).publicKey
        : undefined,
    });

    this.sendWatchdogSpec(session);
    this.replay(session, device.ackedSeq);
  }

  /**
   * Hands a device the contract for watching this hub.
   *
   * The hub names itself here because it is the only party that knows what it
   * is - the device just repeats it back when the silence starts.
   */
  private sendWatchdogSpec(session: Session): void {
    const w = this.opts.deviceWatchdog;
    session.send({
      v: PROTOCOL_VERSION,
      t: 'watchdog',
      enabled: w.enabled,
      intervalMs: w.intervalMs,
      graceMs: w.graceMs,
      alert: {
        title: w.title ?? `${this.opts.name} may be down`,
        body:
          w.body ??
          `No signal from ${this.opts.name} for longer than expected. It may have crashed, or this device may have lost its connection.`,
        severity: w.severity,
      },
    });
  }

  /**
   * Replays notifications the device missed while offline, filtered through
   * its *current* role - demoting a device retroactively narrows its backlog.
   */
  private replay(session: Session, since: number): void {
    const now = Date.now();
    const eligible = this.store.since(since).filter((n) => {
      if (n.ttl && now - n.ts > n.ttl) return false;
      return this.allowed(session, n.channel, n.severity, n.to, false);
    });

    // A device back from a week offline should not be handed hundreds of
    // notifications at once; it gets the recent ones and a count of the rest.
    const limit = this.opts.replayLimit;
    // `slice(-0)` is `slice(0)`, which is everything - so a hub configured to
    // replay nothing replayed the lot. Said explicitly instead.
    const shown = limit <= 0 ? [] : eligible.length > limit ? eligible.slice(-limit) : eligible;
    const skipped = eligible.length - shown.length;

    if (skipped > 0) {
      session.send({
        v: PROTOCOL_VERSION,
        t: 'notification',
        n: {
          // seq 0 keeps this synthetic entry from touching the ack cursor.
          id: `replay-${session.id}-${now}`,
          seq: 0,
          ts: now,
          channel: 'notifyjs',
          severity: 'info',
          title: `${skipped} older notification${skipped === 1 ? '' : 's'} not shown`,
          body: `You were offline for a while. Showing the most recent ${shown.length}.`,
        },
      });
    }

    for (const n of shown) {
      session.send({ v: PROTOCOL_VERSION, t: 'notification', n });
    }
  }

  /* ------------------------------ frames ----------------------------- */

  private handleAck(session: Session, msg: Extract<ClientMessage, { t: 'ack' }>): void {
    if (!session.device || !session.role) return;
    if (!hasCapability(session.role, 'notify.ack')) {
      session.error('forbidden', 'role cannot acknowledge');
      return;
    }
    const ids = Array.isArray(msg.ids) ? msg.ids.slice(0, 500) : [];

    // An action is a claim about which button was pressed, and it was believed
    // without being checked. Applications are told to branch on it - the
    // README's own example does - so an unvalidated value is a way to reach
    // whatever that branch does: on a notification that declared no actions at
    // all, with any string, from any device holding `notify.ack`, which the
    // stock `viewer` role has. Checked against what the notification actually
    // offered, so the only actions that reach an application are ones it
    // published itself.
    const claimed = typeof msg.action === 'string' ? msg.action.slice(0, 128) : undefined;
    const offered = claimed ? this.declaredActions(ids) : undefined;
    // Built once for the frame. `takeAction` used to call `store.history()` -
    // which copies the whole retained array - and then scan it linearly, per
    // id, which is the scan `declaredActions` exists to avoid reintroduced one
    // line below it.
    const held = claimed
      ? new Map(this.store.history().map((entry) => [entry.id, entry]))
      : undefined;
    let taken = false;

    for (const id of ids) {
      const action = claimed ? this.takeAction(session, id, claimed, offered, held) : undefined;
      if (action) taken = true;
      this.emit('ack', { notificationId: id, deviceId: session.device.id, action });
      // One acknowledgement from any entitled device settles the alert. Not a
      // person: see `scheduleAckRetry`, which says what this does and does not mean.
      const timer = this.ackWaiters.get(id);
      if (timer) {
        clearTimeout(timer);
        this.ackWaiters.delete(id);
      }
    }
    // One write for the frame, not one per id. `touchHistory()` is a synchronous
    // serialise, write and rename of the entire retained history, and a device
    // may acknowledge up to five hundred ids in a single frame - five hundred
    // rewrites inside one message, during which the hub answers no pings and
    // rings no calls.
    if (taken) this.store.touchHistory();

    // Clamped to what the hub has actually issued: a device that reported a
    // cursor from the future - a bug, a bad clock, a hostile client - would
    // silently opt itself out of every replay from then on.
    // Compared against the stored record rather than this session's copy of it. A
    // device may hold two sessions - a phone with the app open and its watch
    // service, a browser in two tabs - and each carried its own snapshot, so an
    // ack on one could move the cursor *backwards* over the other's progress. The
    // consequence is a replay of what was already seen rather than a loss, since
    // every client dedupes by id, but it is still the hub forgetting something it
    // had been told.
    const known = this.store.device(session.device.id) ?? session.device;
    if (Number.isFinite(msg.seq) && (msg.seq as number) > known.ackedSeq) {
      const seq = Math.min(msg.seq as number, this.store.seq);
      if (seq > known.ackedSeq) {
        const updated = this.store.updateDevice(session.device.id, { ackedSeq: seq });
        if (updated) session.device = updated;
      }
    }
  }

  /**
   * Decides whether a claimed action actually happened, and records it.
   *
   * Four things have to hold, and each rules out a different way of getting
   * something to run that nobody asked for. The feature has to be on, because
   * a hub that never wanted buttons should not have them. The role has to
   * carry `notify.act`, which no stock role does - `notify.ack` is not enough,
   * and the stock `viewer` has that. The notification has to have published
   * the action, so an application only ever sees strings it chose itself. And
   * nobody can have taken it already: for an action that restarts something,
   * two devices pressing the same button is the difference between a fix and
   * an outage.
   *
   * Recorded on the notification rather than in memory, so a restart does not
   * make an action available for a second time.
   */
  private takeAction(
    session: Session,
    id: string,
    claimed: string,
    offered: Map<string, Set<string>> | undefined,
    held: Map<string, Notification> | undefined,
  ): string | undefined {
    const refuse = (reason: string): undefined => {
      this.audit('ack.action.rejected', {
        deviceId: session.deviceId,
        detail: { id, action: claimed, reason },
      });
      return undefined;
    };

    if (!this.opts.actions.enabled) return refuse('actions are not enabled');
    if (!session.role || !hasCapability(session.role, 'notify.act')) {
      return refuse('role cannot act');
    }
    if (!offered?.get(id)?.has(claimed)) return refuse('the notification did not offer it');

    const n = held?.get(id);
    if (!n) return refuse('unknown notification');
    if (n.actionTaken) return refuse(`already taken by ${n.actionTaken.deviceId}`);

    // Marked on the entry the store holds, by reference; the caller persists
    // once for the whole frame.
    n.actionTaken = { id: claimed, deviceId: session.device!.id, at: Date.now() };

    this.audit('ack.action', { deviceId: session.device!.id, detail: { id, action: claimed } });
    this.emit('action', {
      notificationId: id,
      actionId: claimed,
      deviceId: session.device!.id,
      deviceName: session.device!.name,
    });
    return claimed;
  }

  /**
   * The action ids each of these notifications actually published.
   *
   * Built once per acknowledgement rather than per id: history is bounded, but
   * a device may acknowledge up to five hundred ids in one frame and scanning
   * the log for each of them would make that frame quadratic.
   */
  private declaredActions(ids: string[]): Map<string, Set<string>> {
    const wanted = new Set(ids);
    const found = new Map<string, Set<string>>();
    for (const n of this.store.history()) {
      if (!wanted.has(n.id) || !n.actions?.length) continue;
      found.set(n.id, new Set(n.actions.map((a) => a.id)));
    }
    return found;
  }

  /** A device offering (or withdrawing) a wake-up token for itself. */
  private handlePushRegister(
    session: Session,
    msg: Extract<ClientMessage, { t: 'push.register' }>,
  ): void {
    if (!session.device) return;

    // 2048 rather than 256: an Expo token is short and fixed, but a Web Push
    // endpoint is a URL with an opaque per-subscription path, and FCM's run
    // past 200 characters already. A cap that truncates one is worse than no
    // cap - it stores an endpoint that looks fine and 404s forever.
    const token = typeof msg.token === 'string' ? msg.token.slice(0, 2048) : '';

    // Web Push is the only transport left. A client built before the Expo one
    // was removed still registers its token here, and storing it would leave a
    // device that reads as reachable in `devices list`, is counted as a push
    // target, and silently receives nothing - which is the exact failure this
    // hub already refuses a keyless subscription over. Cleared rather than
    // ignored, so a phone upgrading across the change does not keep a dead
    // token on its record forever.
    if (token && msg.provider !== 'webpush') {
      const cleared = this.store.updateDevice(session.device.id, {
        pushToken: undefined,
        pushProvider: undefined,
        pushKeys: undefined,
      });
      if (cleared) session.device = cleared;
      this.audit('push.rejected', { deviceId: session.device.id });
      this.opts.logger('ignored a wake-up token for a transport this hub no longer has', {
        deviceId: session.device.id,
      });
      return;
    }

    const provider = 'webpush' as const;

    if (!token) {
      const cleared = this.store.updateDevice(session.device.id, {
        pushToken: undefined,
        pushProvider: undefined,
        pushKeys: undefined,
      });
      if (cleared) session.device = cleared;
      this.audit('push.cleared', { deviceId: session.device.id });
      return;
    }

    let keys: WebPushKeys | undefined;
    if (provider === 'webpush') {
      // Checked here rather than at send time. A subscription that cannot be
      // encrypted to is not a subscription, and accepting one would leave a
      // device that reads as reachable in `devices list`, is counted as a push
      // target, and silently receives nothing.
      keys = validWebPushKeys(msg.keys);
      if (!keys || !isPushEndpoint(token)) {
        this.audit('push.rejected', { deviceId: session.device.id });
        this.opts.logger('rejected a web push subscription', {
          deviceId: session.device.id,
          reason: keys ? 'endpoint is not an https URL' : 'missing or malformed keys',
        });
        return;
      }
    }

    const updated = this.store.updateDevice(session.device.id, {
      pushToken: token,
      pushProvider: provider,
      pushKeys: keys,
    });
    if (updated) session.device = updated;
    this.audit('push.registered', { deviceId: session.device.id, detail: { provider } });
  }

  /**
   * Silences one device for a while, at that device's own request.
   *
   * Being paged at 3am with no option but to revoke your own phone is how
   * people end up uninstalling the thing that pages them.
   */
  private handleSnooze(session: Session, msg: Extract<ClientMessage, { t: 'snooze' }>): void {
    if (!session.device) return;

    const requested = Number(msg.untilMs);
    // Cap it: a snooze is a nap, not an off switch, and a bad clock should not
    // be able to silence a device for a decade.
    const max = Date.now() + MAX_SNOOZE_MS;
    const until =
      Number.isFinite(requested) && requested > Date.now() ? Math.min(requested, max) : 0;

    const updated = this.store.updateDevice(session.device.id, {
      snoozedUntil: until || undefined,
    });
    if (updated) session.device = updated;

    this.audit(until ? 'device.snoozed' : 'device.unsnoozed', {
      deviceId: session.device.id,
      detail: until ? { until } : undefined,
    });
  }

  private handleSync(session: Session, msg: Extract<ClientMessage, { t: 'sync' }>): void {
    const since = Number.isFinite(msg.since) ? Math.max(0, Number(msg.since)) : 0;
    this.replay(session, since);
  }

  /* ------------------------------ admin ------------------------------ */

  private async handleAdmin(
    session: Session,
    msg: Extract<ClientMessage, { t: 'admin' }>,
  ): Promise<void> {
    const reply = (ok: boolean, data?: unknown, error?: string) => {
      // Says who exercised a privilege, and not only who was refused.
      //
      // `admin.denied` has always named the device turned away, while a change
      // that succeeded left either a line naming its target and nothing about
      // the administrator behind it, or - for roles, policies and revoked
      // pairing codes - no line at all. An audit log that can say a role was
      // rewritten but not by whom is half a log, and rewriting a role is how
      // somebody grants themselves the rest of the hub.
      //
      // Here rather than in each method: this is the one place every admin
      // frame passes through on its way back out, and it fires only for a
      // mutation that actually succeeded.
      if (ok && ATTRIBUTED_ADMIN_OPS.has(msg.op)) {
        this.audit('admin.applied', {
          ip: session.ip,
          deviceId: session.deviceId,
          detail: { op: msg.op, target: adminTarget(args) },
        });
      }
      return session.send({ v: PROTOCOL_VERSION, t: 'admin.result', id: msg.id, ok, data, error });
    };

    const role = session.role;
    if (!role) return reply(false, undefined, 'not ready');

    const required = ADMIN_CAPABILITY[msg.op];
    if (!required || !hasCapability(role, required)) {
      this.audit('admin.denied', { deviceId: session.deviceId, detail: { op: msg.op } });
      return reply(false, undefined, 'forbidden');
    }

    const args = (msg.args ?? {}) as Record<string, any>;
    try {
      switch (msg.op) {
        case 'devices.list':
          return reply(true, { devices: this.store.devices(), online: this.onlineDeviceIds() });
        case 'devices.revoke':
          return reply(true, { revoked: this.revokeDevice(String(args.deviceId)) });
        case 'devices.rename':
          return reply(true, {
            device: this.renameDevice(String(args.deviceId), String(args.name)),
          });
        case 'devices.setRole':
          this.assertMayGrantRole(session, role, String(args.role));
          return reply(true, {
            device: this.setDeviceRole(String(args.deviceId), String(args.role)),
          });
        case 'pair.create':
          this.assertMayGrantRole(session, role, String(args.role ?? 'viewer'));
          return reply(true, this.createPairingCode(args));
        case 'pair.list':
          return reply(true, { codes: this.pairingCodes() });
        case 'pair.revoke':
          return reply(true, { revoked: this.revokePairingCode(String(args.hash)) });
        case 'ingest.create': {
          // Gated exactly like a pairing code, and for the same reason: a
          // token publishes with its role's permissions, so minting one into
          // a role you do not hold is privilege escalation with an extra step.
          const wanted = String(args.role ?? 'viewer');
          this.assertMayGrantRole(session, role, wanted);
          const label = typeof args.label === 'string' ? args.label : undefined;
          return reply(true, this.createIngestToken({ role: wanted, label }));
        }
        case 'ingest.list':
          return reply(true, { tokens: this.ingestTokens() });
        case 'ingest.revoke':
          return reply(true, { revoked: this.revokeIngestToken(String(args.id)) });
        case 'roles.list':
          return reply(true, { roles: this.roles() });
        case 'roles.upsert': {
          // A role may only carry the privileged capabilities its author
          // already holds. Blocking `admin` alone was not enough:
          // `devices.manage` mints pairing codes and `roles.manage` writes the
          // role they point at, so either one composes back into admin.
          const next = sanitizeRole(args, role.capabilities);
          // Stripping is right for a new role, but applied to one that already
          // exists it quietly rewrote it: a `roles.manage` device saving the
          // `admin` role's description sent it back with no capabilities, and
          // every admin device lost its authority on the spot.
          const existing = this.store.role(next.name);
          if (existing && escalatingCapabilities(role, existing.capabilities).length > 0) {
            throw new Error(`role ${next.name} carries capabilities you do not hold`);
          }
          this.upsertRole(next);
          return reply(true, { roles: this.roles() });
        }
        case 'roles.delete':
          return reply(true, { deleted: this.deleteRole(String(args.name)) });
        case 'notify.send':
          // Awaited. Sending touches no network - the Web Push fan-out is
          // deliberately left to run on its own - so there is nothing to wait
          // for beyond the work itself, and the caller hears about a failure
          // instead of being told `ok` while the rejection was discarded.
          await this.notify(args as NotifyInput);
          return reply(true, {});
        case 'call.place': {
          // A call rings for as long as its ladder says, so this one reply
          // cannot wait for the outcome. It must still not claim success for a
          // call that never got off the ground: the one failure raised before
          // anything rings is a policy name that does not exist, and that is
          // precisely the typo a caller needs to hear about. `notifyjs call
          // --policy nigt-shift` printed "call placed" and rang nobody.
          const wanted = typeof args.policy === 'string' ? args.policy.trim() : '';
          if (wanted && !this.store.policy(wanted)) {
            return reply(false, undefined, `unknown escalation policy: ${wanted}`);
          }
          // Checked here as well, because the ring cannot be awaited: `call()`
          // would refuse the same value, but into a rejection this case discards -
          // so a malformed `to` answered "call placed" and rang nobody.
          try {
            sanitizeTargeting(args.to as Targeting | undefined);
          } catch (err) {
            return reply(false, undefined, err instanceof Error ? err.message : String(err));
          }
          // The checked value is the one that gets used. Validating the trimmed
          // name and then passing the original meant `policy: ' night-shift '`
          // walked through the guard and threw inside `call()` instead, into the
          // same swallowed catch - answering `ok` for a call that rang nobody,
          // one space away from the bug this check was added for.
          if (wanted) args.policy = wanted;
          void this.call(args as CallInput).catch(() => {});
          return reply(true, {});
        }
        case 'notify.resolve':
          // Awaited: replying with the promise itself serialises to `{}`, so
          // every caller was told nothing had been resolved.
          return reply(true, { resolved: await this.resolve(args as { id?: string; key?: string }) });
        case 'heartbeats.list':
          return reply(true, { heartbeats: this.heartbeats() });
        case 'heartbeat.expect': {
          const floor = this.opts.heartbeatTickMs;
          return reply(true, {
            heartbeat: this.expect(
              String(args.name),
              sanitizeHeartbeat(args as unknown as HeartbeatSpec, floor),
            ),
          });
        }
        case 'heartbeat.checkin':
          return reply(true, { known: this.checkIn(String(args.name)) });
        case 'heartbeat.forget':
          return reply(true, { forgotten: this.forget(String(args.name)) });
        case 'policies.list':
          return reply(true, { policies: this.policies() });
        case 'policies.upsert':
          this.upsertPolicy(args as unknown as EscalationPolicy);
          return reply(true, { policies: this.policies() });
        case 'policies.delete':
          return reply(true, { deleted: this.deletePolicy(String(args.name)) });
        case 'metrics':
          return reply(true, { text: this.renderMetrics() });
        case 'audit.tail':
          return reply(true, { events: this.auditLog(Number(args.limit) || 100) });
        case 'history':
          // Filtered through the caller's role, exactly as `replay()` is. The
          // capability only says "this device receives notifications"; which
          // notifications is still decided by its channel patterns, its
          // minimum severity and the alert's own targeting. Reading the log
          // must not be a way around the filter that governs delivery.
          return reply(true, {
            notifications: this.visibleHistory(session).slice(-(Number(args.limit) || 100)),
          });
        default:
          return reply(false, undefined, 'unknown op');
      }
    } catch (err) {
      return reply(false, undefined, err instanceof Error ? err.message : 'failed');
    }
  }

  /**
   * Refuses to hand out a role carrying capabilities the caller lacks.
   *
   * Least privilege is only least privilege if it cannot be widened from
   * inside. Without this, `devices.manage` is `admin`: mint a pairing code for
   * the admin role, or point your own device at it, and the capability you
   * were not given is one frame away. Only the privileged capabilities are
   * held back, so onboarding an ordinary viewer still works - see
   * `PRIVILEGED_CAPABILITIES`.
   */
  private assertMayGrantRole(session: Session, actor: Role, roleName: string): void {
    const target = this.store.role(roleName);
    // An unknown role is not this check's business; the operation itself
    // reports it, and rejecting here would answer a typo with "forbidden".
    if (!target) return;
    const missing = escalatingCapabilities(actor, target.capabilities);
    if (missing.length === 0) return;

    this.audit('admin.denied', {
      deviceId: session.deviceId,
      detail: { op: 'grant', role: roleName, missing },
    });
    throw new Error(
      `cannot grant "${roleName}": it carries ${missing.join(', ')}, which this device does not hold`,
    );
  }

  /** Whether this session is entitled to steer a call it is part of. */
  private canAnswerCalls(session: Session): boolean {
    return Boolean(session.role && session.deviceId && hasCapability(session.role, 'call.receive'));
  }

  /**
   * The stored history, narrowed to what this device was entitled to receive.
   *
   * Deliberately `canDeliver` rather than `allowed()`: the extra rule that one
   * adds is the snooze, and a snooze means "stop buzzing me", not "hide the
   * incident log from me until it lifts".
   */
  private visibleHistory(session: Session): Notification[] {
    const role = session.role;
    const device = session.device;
    if (!role || !device) return [];
    return this.store.history().filter((n) =>
      canDeliver({
        role,
        deviceId: device.id,
        channel: n.channel,
        severity: n.severity,
        to: n.to,
        isCall: false,
      }),
    );
  }

  /* ---------------------------- delivery ----------------------------- */

  private buildNotification(input: NotifyInput): Notification {
    return {
      id: randomId(10),
      seq: this.store.nextSeq(),
      ts: Date.now(),
      channel: sanitizeChannel(input.channel),
      // An unrecognised severity would sort as `debug`, bypass the
      // `alwaysDeliver` list, and be written verbatim into a Prometheus label
      // at `/metrics`.
      severity: coerceSeverity(input.severity, 'info'),
      title: String(input.title ?? '').slice(0, 200),
      body: input.body ? String(input.body).slice(0, 4000) : undefined,
      tags: input.tags?.slice(0, 20),
      data: input.data,
      actions: input.actions?.slice(0, 5),
      requireAck: input.requireAck,
      ttl: input.ttl,
      to: sanitizeTargeting(input.to),
      resolveKey: input.resolveKey,
    };
  }

  private buildCall(input: CallInput): CallRequest {
    return {
      id: randomId(10),
      seq: this.store.nextSeq(),
      ts: Date.now(),
      channel: sanitizeChannel(input.channel),
      severity: coerceSeverity(input.severity, 'critical'),
      from: sanitizeName(input.from) || this.opts.name,
      message: sanitizeMessage(input.message, 2000),
      lang: input.lang,
      rate: input.rate,
      pitch: input.pitch,
      // Clamped like every other number a timer will consume. This one reaches
      // `setTimeout(ringSeconds * 1000)` for every rung of the ladder, and it
      // arrived straight off the wire: `"soon"` multiplied out to NaN, which
      // `setTimeout` fires at 1ms, so each phone got a `call` frame followed
      // immediately by `call.cancel: missed`, nothing rang audibly, and the
      // caller was told the page was missed. A negative value did the same, and
      // `1e12` - which reads like "ring for a long time" - overflowed the timer
      // into the same instant collapse. `sanitizePolicy` already clamps a
      // policy's own steps; this is the value they fall back to.
      ringSeconds: clampNumber(
        input.ringSeconds,
        1,
        MAX_RING_SECONDS,
        this.opts.defaultRingSeconds,
      ),
      repeat: input.repeat,
      to: sanitizeTargeting(input.to),
      escalate: input.escalate,
      policy: input.policy,
    };
  }

  private allowed(
    session: Session,
    channel: string,
    severity: Severity,
    to: Targeting | undefined,
    isCall: boolean,
  ): boolean {
    if (!session.role || !session.device) return false;

    if (snoozeHolds(session.device, severity)) return false;

    return canDeliver({
      role: session.role,
      deviceId: session.device.id,
      channel,
      severity,
      to,
      isCall,
    });
  }

  /**
   * Writes a notification to every entitled socket, and reports which devices
   * it actually reached.
   *
   * The two are not the same. A frozen app still holds an open socket that its
   * networking library keeps answering pings on, so the frame is written and
   * buffered and nobody reads it until the app is next opened - which is what
   * made an alert arrive an hour late, all at once, on the phone it was for.
   * It is still sent, because it costs nothing and is there the moment the app
   * thaws; it is not counted, because counting it is what suppressed the push
   * that would have woken the app in the first place.
   */
  private deliver(n: Notification): string[] {
    const reached = new Set<string>();
    for (const session of this.sessions.values()) {
      if (session.state !== 'ready' || !session.device) continue;
      if (!this.allowed(session, n.channel, n.severity, n.to, false)) continue;
      session.send({ v: PROTOCOL_VERSION, t: 'notification', n });
      if (!this.awake(session)) continue;
      // A device may hold several sockets; it is still one device reached.
      reached.add(session.device.id);
    }
    return [...reached];
  }

  /**
   * Whether this session's peer is still running, not merely still connected.
   *
   * The deadline is the sweep interval with the same tolerance the client
   * allows itself before it reconnects, so the two sides agree on when a
   * connection has stopped meaning anything.
   */
  private awake(session: Session): boolean {
    return session.awake(this.opts.livenessIntervalMs * KEEPALIVE_MISSES);
  }

  /**
   * Re-sends an unacknowledged notification until some device acks it, its TTL
   * runs out, or we hit the attempt ceiling.
   *
   * What this guarantees is that the alert reached a device that could show it -
   * not that anybody looked. Every client here acknowledges as soon as it has the
   * frame, and `SourceManager` deliberately acks even an alert the person's own
   * severity floor hides from them, on the grounds that "the person chose not to
   * see it, which is not the same as never having received it". So this is
   * delivery confirmation with teeth, and a claim about a human being would need a
   * second kind of acknowledgement that no client sends.
   *
   * Tracked hub-wide in `ackWaiters`, keyed by notification, rather than per
   * session: one acknowledgement from any entitled device is what settles an
   * alert, so a per-socket set of outstanding ids would have nothing to decide.
   */
  private scheduleAckRetry(n: Notification): void {
    let attempts = 0;
    const tick = () => {
      // handleAck() deletes the entry, which is how an acknowledgement stops
      // the loop; the timer may already have been cleared by then.
      if (!this.ackWaiters.has(n.id)) return;
      const expired = n.ttl !== undefined && Date.now() - n.ts > n.ttl;
      if (expired || ++attempts > MAX_ACK_RETRIES) {
        this.ackWaiters.delete(n.id);
        return;
      }
      this.deliver(n);
      this.arm(n.id, tick);
    };
    this.arm(n.id, tick);
  }

  private arm(id: string, fn: () => void): void {
    const timer = setTimeout(fn, this.opts.ackRetryMs);
    timer.unref?.();
    this.ackWaiters.set(id, timer);
  }

  private callTargets(req: CallRequest, extra?: Targeting): CallTarget[] {
    const seen = new Set<string>();
    const targets: CallTarget[] = [];
    for (const session of this.sessions.values()) {
      if (session.state !== 'ready' || !session.device) continue;
      if (seen.has(session.device.id)) continue;
      // A rung spent ringing a phone whose app is frozen is a rung the person
      // holding it never hears. Left out here so the ladder moves on and
      // `pushCallToOffline` treats it as a device to wake.
      if (!this.awake(session)) continue;
      if (!this.allowed(session, req.channel, req.severity, req.to, true)) continue;
      // A policy rung narrows further, on top of the call's own targeting.
      if (extra && !matchesTargeting(extra, session.device.id, session.device.role)) continue;
      seen.add(session.device.id);
      targets.push({
        deviceId: session.device.id,
        deviceName: session.device.name,
        send: (m) => session.send(m),
      });
    }
    // Most recently *used* device first: the phone in someone's hand should ring
    // before the tablet that has been on a shelf since Tuesday.
    //
    // Ordered by `lastActiveAt`, not `lastSeenAt`. Every device here is
    // connected, so "seen" cannot separate them - it recorded when each one
    // authenticated, which ranked a tablet that had just reconnected after a
    // network blip above a phone that had been reliably present all day, the
    // exact inversion of what this is for. Falling back to `lastSeenAt` keeps
    // a device that has never done anything in the running, just last.
    const rank = (deviceId: string) => {
      const device = this.store.device(deviceId);
      return device?.lastActiveAt ?? device?.lastSeenAt ?? 0;
    };
    return targets.sort((a, b) => rank(b.deviceId) - rank(a.deviceId));
  }

  private audit(kind: string, extra: Omit<AuditEvent, 'ts' | 'kind'> = {}): void {
    this.store.audit({ ts: Date.now(), kind, ...extra });
  }

  /**
   * Finds the dashboard assets, in order of how explicit the answer is.
   *
   * The `require.resolve` path works when the hub runs from node_modules, but
   * a packaged single-file binary has no module graph to resolve against - so
   * a `dashboard/` directory sitting next to the executable is checked too,
   * which is how the released archives are laid out.
   */
  private async locateDashboard(): Promise<string | undefined> {
    const explicit = [this.opts.dashboardDir, process.env.NOTIFYJS_DASHBOARD_DIR];
    for (const dir of explicit) {
      if (dir && (await isDirectory(dir))) return dir;
    }

    try {
      const require = createRequire(import.meta.url);
      const entry = require.resolve('@osqd/notifyjs-web');
      return dirname(entry);
    } catch {
      // Not resolvable: either a packaged binary, or web is not installed.
    }

    const besideExecutable = join(dirname(process.execPath), 'dashboard');
    if (await isDirectory(besideExecutable)) return besideExecutable;

    this.opts.logger('dashboard assets not found; serving API only');
    return undefined;
  }
}

/* -------------------------------------------------------------------- */

/**
 * A Web Push endpoint, or nothing.
 *
 * `https` only. The hub POSTs an encrypted body here on every alert, and a
 * device that could nominate an `http:` endpoint would be asking the hub to
 * announce, in the clear and repeatedly, that something is wrong - which is
 * most of what an observer wants to know. See the metadata note in SECURITY.md.
 */
function isPushEndpoint(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The subscription keys, checked for the shapes RFC 8291 requires.
 *
 * Both lengths are fixed by the spec: an uncompressed P-256 point is 65 bytes
 * beginning 0x04, and the auth secret is 16. Anything else cannot be encrypted
 * to, and finding that out at send time means finding it out once per alert.
 */
function validWebPushKeys(keys: unknown): WebPushKeys | undefined {
  if (typeof keys !== 'object' || keys === null) return undefined;
  const { p256dh, auth } = keys as Record<string, unknown>;
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return undefined;

  const point = Buffer.from(p256dh, 'base64url');
  const secret = Buffer.from(auth, 'base64url');
  if (point.length !== 65 || point[0] !== 0x04) return undefined;
  if (secret.length !== 16) return undefined;

  return { p256dh, auth };
}

/**
 * Narrows push-eligible devices to the ones Web Push can actually reach.
 *
 * There used to be two transports to sort between. With Expo gone there is
 * one, so the only question left is whether a device carries a subscription
 * that can be encrypted to. Anything claiming `webpush` without keys is
 * dropped here rather than passed on - it cannot be encrypted to, so handing
 * it to the sender would only produce a failure further from the cause. A
 * token left behind by the old Expo path is ignored for a plainer reason:
 * nothing can deliver to it any more.
 */
function webPushTargets(
  devices: Device[],
): Array<{ deviceId: string; endpoint: string; keys: WebPushKeys }> {
  const targets: Array<{ deviceId: string; endpoint: string; keys: WebPushKeys }> = [];
  for (const device of devices) {
    if (device.pushProvider !== 'webpush') continue;
    if (!device.pushToken || !device.pushKeys) continue;
    targets.push({ deviceId: device.id, endpoint: device.pushToken, keys: device.pushKeys });
  }
  return targets;
}

/**
 * The version this build reports, and how it knows.
 *
 * `process.env.NOTIFYJS_VERSION` is stamped in at bundle time, which covers the
 * released binaries and the container. Everything installed from npm has no such
 * stamp, and the literal that used to stand in its place meant an
 * `npm i -g @osqd/notifyjs-cli` hub reported `0.1.0` for ever: `serve` asked the
 * release feed whether anything newer existed, was told yes on every start for
 * the rest of the project's life, and the dashboard's own upgrade nudge compared
 * a constant and could never fire. Read from the manifest beside the code
 * instead, which is the version that was actually published.
 */
function ownVersion(fallback: string): string {
  const stamped = process.env.NOTIFYJS_VERSION;
  if (stamped) return stamped;
  try {
    // `dist/` sits one level under the package root. `createRequire` rather than
    // a JSON import, which needs an attribute older runtimes reject outright.
    const version = createRequire(import.meta.url)('../package.json').version as unknown;
    return typeof version === 'string' && version ? version : fallback;
  } catch {
    // A checkout run straight from source, or a layout nobody expected: saying
    // the wrong version is better than refusing to start over it.
    return fallback;
  }
}

const NOTIFYJS_VERSION = ownVersion('0.1.0');

/** How precisely an ingest token's last use is recorded. See `handleIngest`. */
const INGEST_LAST_USED_RESOLUTION_MS = 60_000;

const MAX_ACK_RETRIES = 20;

/** A pairing code is meant to be redeemed now, not next week. */
const MAX_CODE_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_CODE_USES = 100;

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** A snooze is a nap, not an off switch. */
const MAX_SNOOZE_MS = 24 * 60 * 60_000;

/**
 * How stale a device's timestamps may get before a frame refreshes them.
 *
 * These are read by a human looking at a device list and by the call ladder,
 * neither of which needs second-level precision - and writing on every frame
 * would put a store write on the hot path of the noisiest device.
 */
const DEVICE_TOUCH_MS = 30_000;

/**
 * Keepalives a device may miss before the hub stops counting it as reachable.
 *
 * Matches the client's own tolerance, so neither side declares the connection
 * useless while the other still believes in it. Being wrong costs one push to
 * a phone that was about to read the socket anyway; being right is the
 * difference between a page arriving and a page arriving tomorrow.
 */
const KEEPALIVE_MISSES = 2.5;

/** Null-prototyped: the key is derived from a request path. */
const MIME: Record<string, string> = Object.assign(Object.create(null), {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
});

/**
 * Least privilege per admin op; `admin` satisfies all of them implicitly.
 *
 * Null-prototyped, because `msg.op` comes off the wire and indexes this table
 * directly. A plain object answers `ADMIN_CAPABILITY['constructor']` with a
 * truthy function - which today fails the `hasCapability` check that follows
 * and so denies the frame, but only by accident. An authorization table should
 * not depend on the next line to catch a key it should never have returned.
 */
const ADMIN_CAPABILITY: Record<string, Capability> = Object.assign(Object.create(null), {
  'devices.list': 'devices.manage',
  'devices.revoke': 'devices.manage',
  'devices.rename': 'devices.manage',
  'devices.setRole': 'devices.manage',
  'pair.create': 'devices.manage',
  'pair.list': 'devices.manage',
  'pair.revoke': 'devices.manage',
  // Minting a publishing credential is managing who may reach this hub, which
  // is the same authority that mints pairing codes. Listing is kept at the
  // same level rather than a softer one: the labels say what publishes here,
  // which is exactly the map an attacker would want first.
  'ingest.create': 'devices.manage',
  'ingest.list': 'devices.manage',
  'ingest.revoke': 'devices.manage',
  'roles.list': 'notify.receive',
  'roles.upsert': 'roles.manage',
  'roles.delete': 'roles.manage',
  'notify.send': 'notify.send',
  'notify.resolve': 'notify.send',
  'heartbeats.list': 'notify.receive',
  'heartbeat.expect': 'notify.send',
  'heartbeat.checkin': 'notify.send',
  'heartbeat.forget': 'notify.send',
  'policies.list': 'notify.receive',
  'policies.upsert': 'roles.manage',
  'policies.delete': 'roles.manage',
  metrics: 'audit.read',
  'call.place': 'call.place',
  'audit.tail': 'audit.read',
  history: 'notify.receive',
});

/**
 * Admin operations whose success is recorded with the device that asked for it.
 *
 * The configuration and authority changes only. `notify.send`, `call.place` and
 * `heartbeat.checkin` are left out: the first two already write their own audit
 * line, and all three are ordinary traffic rather than a change to what the hub
 * is - attributing them would bury the lines that matter under the ones that do
 * not.
 */
const ATTRIBUTED_ADMIN_OPS = new Set([
  'devices.revoke',
  'devices.rename',
  'devices.setRole',
  'pair.create',
  'pair.revoke',
  'ingest.create',
  'ingest.revoke',
  'roles.upsert',
  'roles.delete',
  'policies.upsert',
  'policies.delete',
  'heartbeat.expect',
  'heartbeat.forget',
]);

/**
 * What an admin frame was aimed at, for the audit line.
 *
 * Deliberately never `args.code`: a pairing code is a live credential until it
 * is redeemed, and the audit log is readable by anybody holding `audit.read`.
 */
function adminTarget(args: Record<string, unknown>): string | undefined {
  for (const key of ['deviceId', 'name', 'id', 'label', 'role']) {
    const value = args[key];
    if (typeof value === 'string' && value) return value.slice(0, 64);
  }
  return undefined;
}

/** A valid, throwaway key used to keep failed-auth timing flat. */
const DECOY_PUBLIC_KEY = 'BdC4l3lXbNIqjRfjP8ycxHDCiMMVBpjs7ymEQR8lPFY';

function randomId(bytes: number): string {
  return toBase64Url(nodeCrypto.randomBytes(bytes));
}

/**
 * Whether a snooze on this device holds an alert of this severity back.
 *
 * Extracted because it was written into the socket path alone, and the Web Push
 * fan-out filtered with `canDeliver`, which knows nothing about snoozing. The two
 * combined perversely: `deliver()` skipped the snoozed session, so the device was
 * absent from `deliveredTo` - the very set the fan-out treats as "already
 * reached" - and snoozing a device therefore *promoted* it from suppressed to
 * "offline, wake it". Somebody who asked for quiet got a lock-screen push for an
 * alert their app was deliberately not showing them.
 *
 * A critical alert is never held: the point is to quiet noise, not to switch the
 * pager off.
 */
function snoozeHolds(
  device: { snoozedUntil?: number },
  severity: Severity,
  now = Date.now(),
): boolean {
  return (device.snoozedUntil ?? 0) > now && severity !== 'critical';
}

/** Whether a device satisfies an explicit role/device restriction. */
function matchesTargeting(to: Targeting, deviceId: string, role: string): boolean {
  // Guarded like `canDeliver`: an unreadable restriction matches nothing.
  if (to.devices !== undefined) {
    if (!Array.isArray(to.devices)) return false;
    if (to.devices.length > 0 && !to.devices.includes(deviceId)) return false;
  }
  if (to.roles !== undefined) {
    if (!Array.isArray(to.roles)) return false;
    if (to.roles.length > 0 && !to.roles.includes(role)) return false;
  }
  return true;
}

/**
 * Validates an explicit device or role restriction.
 *
 * Refused rather than repaired, and refused here, because this value is
 * persisted with the notification: `notify()` writes to history *before* it
 * delivers. A `to` of `{ devices: { length: 1 } }` - accepted from the lowest
 * publishing capability there is, and one an HTTP ingest token holds - was
 * stored verbatim, and `canDeliver` then threw on `.includes` inside `deliver()`
 * and, far worse, inside `replay()`. Every client syncs on `ready`, on returning
 * to the foreground and on waking, so every device on the hub was closed with an
 * internal error and reconnected into the same failure, indefinitely, across
 * restarts - recoverable only by editing `history.jsonl` by hand, while the hub
 * went on looking healthy because new alerts still delivered.
 */
function sanitizeTargeting(to: Targeting | undefined): Targeting | undefined {
  if (to === undefined || to === null) return undefined;
  if (typeof to !== 'object' || Array.isArray(to)) {
    throw new Error('`to` must be an object with `devices` or `roles`');
  }

  const clean: Targeting = {};
  for (const key of ['devices', 'roles'] as const) {
    const list = (to as Record<string, unknown>)[key];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string')) {
      throw new Error(`\`to.${key}\` must be an array of strings`);
    }
    // Refused, not trimmed: every other malformed shape here is refused by name,
    // and quietly delivering an alert aimed at 250 devices to 200 of them is the
    // kind of silence this function exists to remove.
    if (list.length > MAX_TARGETS) {
      throw new Error(`\`to.${key}\` may name at most ${MAX_TARGETS} entries, not ${list.length}`);
    }
    // Copied, not aliased. This value is persisted with the notification, and a
    // caller that reuses or clears its target buffer afterwards was silently
    // rewriting history: an emptied list reads as "no restriction", so a
    // device-restricted alert became a broadcast on the next replay.
    clean[key] = [...(list as string[])];
  }
  return clean.devices || clean.roles ? clean : undefined;
}

/** Most devices or roles one alert may be aimed at. */
const MAX_TARGETS = 200;

/** Ceiling for a heartbeat that arrived over the wire. */
const MAX_WIRE_HEARTBEAT_MS = 30 * 24 * 60 * 60_000;

/**
 * Bounds a heartbeat asked for over the wire.
 *
 * `heartbeat.expect` was the one wire-reachable path that armed a timer with
 * nothing clamping it, and it needs only `notify.send` - the lowest publishing
 * capability, and one an HTTP ingest token can hold. `{ every: 1, repeat: true }`
 * was taken as written: the sweep found it overdue on every tick, `repeat`
 * re-armed the clock, and each miss raised a `critical` alert - which flood
 * control never collapses and `requireAck` then re-sends for twenty rounds. The
 * beat is stored, so it outlived both a restart and the device that set it.
 *
 * The floor is the sweep interval itself, and nothing more: a deadline shorter
 * than the tick that checks it is missed on the next tick however honest the
 * task, while anything above it is a cadence somebody may genuinely want -
 * `RemoteNotifier.keepAlive` is the documented way for a monitored process to
 * check in, and it comes through here. A programmatic caller on the hub's own
 * side keeps the unbounded API; it is describing its own process rather than
 * pointing a repeating page at somebody else's phone.
 */
function sanitizeHeartbeat(input: HeartbeatSpec, floorMs: number): HeartbeatSpec {
  const raw = (input ?? {}) as Partial<HeartbeatSpec>;
  if (raw.every === undefined) throw new Error('a heartbeat needs an interval');

  const asked = parseDuration(raw.every);
  // Refused rather than trimmed. Silently arming 30 days for a task that checks
  // in quarterly manufactures the thing this module exists to avoid: a critical
  // page, repeated every tick, for a job that is not late. The floor may only
  // make a deadline later, so that one is safe to apply quietly.
  if (asked > MAX_WIRE_HEARTBEAT_MS) {
    throw new Error(
      `a heartbeat interval must be ${formatDuration(MAX_WIRE_HEARTBEAT_MS)} or less, not ${formatDuration(asked)}`,
    );
  }
  const grace = raw.grace === undefined ? 0 : parseDuration(raw.grace);
  if (grace > MAX_WIRE_HEARTBEAT_MS) {
    throw new Error(
      `a heartbeat's grace must be ${formatDuration(MAX_WIRE_HEARTBEAT_MS)} or less, not ${formatDuration(grace)}`,
    );
  }

  const clean: HeartbeatSpec = {
    every: Math.max(floorMs, asked),
    grace,
    severity: coerceSeverity(raw.severity, 'critical'),
    repeat: raw.repeat === true,
  };
  if (typeof raw.channel === 'string') clean.channel = raw.channel;
  if (typeof raw.description === 'string') clean.description = raw.description;
  return clean;
}

/** Ceilings for a ladder that arrived over the wire. */
const MAX_POLICY_STEPS = 50;
const MAX_RING_SECONDS = 600;
const MAX_STEP_DELAY_SECONDS = 3600;
const MAX_POLICY_REPEAT = 10;

/**
 * Normalises an escalation policy, bounding everything a timer will consume.
 *
 * Written as a total function over unknown input: the wire path passes the
 * frame's `args` through unchanged, so a missing `steps` or a `ringSeconds` of
 * `"soon"` has to produce a usable ladder or a clear error, never a NaN that
 * `setTimeout` quietly fires immediately.
 */
function sanitizePolicy(input: EscalationPolicy): EscalationPolicy {
  const raw = (input ?? {}) as Partial<EscalationPolicy>;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 64) : '';
  if (!name) throw new Error('an escalation policy needs a name');
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new Error('an escalation policy needs at least one step');
  }

  const steps = raw.steps.slice(0, MAX_POLICY_STEPS).map((step) => {
    const s = (step ?? {}) as Record<string, unknown>;
    const out: EscalationPolicy['steps'][number] = {};
    // Left unset when the value is not a number: `buildLadder` then falls back
    // to the call's own ring duration, which is a better answer than a figure
    // invented here.
    const ring = Number(s.ringSeconds);
    if (Number.isFinite(ring)) {
      out.ringSeconds = Math.min(MAX_RING_SECONDS, Math.max(1, Math.floor(ring)));
    }
    const delay = Number(s.delaySeconds);
    if (Number.isFinite(delay)) {
      out.delaySeconds = Math.min(MAX_STEP_DELAY_SECONDS, Math.max(0, Math.floor(delay)));
    }
    const to = s.to as Targeting | undefined;
    if (to && typeof to === 'object') {
      out.to = {
        roles: stringList(to.roles),
        devices: stringList(to.devices),
      };
    }
    return out;
  });

  const policy: EscalationPolicy = { name, steps };
  if (typeof raw.description === 'string') policy.description = raw.description.slice(0, 200);
  if (raw.repeat !== undefined) {
    // An unbounded repeat is a ladder that never stops climbing.
    policy.repeat = clampNumber(raw.repeat, 0, MAX_POLICY_REPEAT, 0);
  }
  return policy;
}

/** A bounded list of strings, for targeting that arrived over the wire. */
function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === 'string').slice(0, 100);
  return out.length > 0 ? out : undefined;
}

function withSeverity(input: NotifyInput | string, severity: Severity): NotifyInput {
  return typeof input === 'string' ? { title: input, severity } : { ...input, severity };
}

/**
 * Channels name a routing key, and one arrives with every notification.
 *
 * Only control characters and length are corrected: a channel is matched
 * against role globs an operator wrote by hand, so quietly rewriting the
 * printable characters would stop a role from matching the channel it was
 * configured for.
 */
function sanitizeChannel(value: unknown): string {
  if (typeof value !== 'string') return 'default';
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
  }
  return out.trim().slice(0, 64) || 'default';
}

/** IPv4 or IPv6 literal, for deciding whether a proxy header is believable. */
/** A JSON object and nothing else - arrays and null are not payloads. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads a JSON body, refusing to buffer more than it was told to.
 *
 * The limit is enforced as the bytes arrive rather than after: waiting for
 * `end` before checking the length is how an unauthenticated caller gets the
 * hub to hold an arbitrary amount of memory for them. The socket is destroyed
 * on breach, because a peer that is still sending has not stopped just because
 * a promise rejected.
 */
async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        // Paused rather than destroyed. Destroying here does stop the
        // buffering, but it also tears down the socket before the 413 can be
        // written - so the caller sees a connection reset and has no idea why
        // their alert vanished. Pausing applies backpressure just as well and
        // leaves the connection alive long enough to say what went wrong; the
        // handler closes it once the response is out.
        req.pause();
        reject(new Error('too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve());
    req.on('error', (err) => reject(err));
  });

  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!isPlainObject(parsed)) throw new Error('not an object');
  return parsed;
}

function isIpAddress(value: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return value.split('.').every((part) => Number(part) <= 255);
  }
  return /^[0-9a-fA-F:]{2,45}$/.test(value) && value.includes(':');
}

/**
 * Device-supplied names land in dashboards, logs and phone screens. Dropping
 * control characters keeps a device from smuggling ANSI escapes into an
 * operator's terminal or breaking a log line in two.
 */
/**
 * Text that will reach somebody's terminal, with the control characters removed.
 *
 * `sanitizeName` does this for names and channels, and SECURITY.md says titles and
 * bodies are handled at the CLI - which left a call's spoken message and an ingest
 * token's label as the two strings that reached a terminal raw. An escape sequence in
 * a call message clears the operator's screen and repaints whatever it likes:
 * `notifyjs listen` prints it the moment a call arrives, which is exactly when
 * somebody is looking. Newlines are kept, because a message may legitimately have
 * them and they cannot reposition a cursor.
 */
function sanitizeMessage(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\n') {
      out += ch;
      continue;
    }
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue;
    out += ch;
  }
  return out.slice(0, limit);
}

function sanitizeName(value: unknown): string {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
  }
  return out.trim().slice(0, 64);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function refuse(socket: Duplex, status: number, text: string, retryAfter?: number): void {
  const headers = [
    `HTTP/1.1 ${status} ${text}`,
    'Connection: close',
    'Content-Length: 0',
    retryAfter !== undefined ? `Retry-After: ${retryAfter}` : '',
  ].filter(Boolean);
  try {
    socket.write(headers.join('\r\n') + '\r\n\r\n');
  } catch {
    /* peer already gone */
  }
  socket.destroy();
}
