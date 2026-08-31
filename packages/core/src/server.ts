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
import { Guard, normalizeIp, uniformDelay } from './guard.js';
import { Session } from './session.js';
import { CallOrchestrator, type CallEvent, type CallStep, type CallTarget } from './calls.js';
import { Watchdog, formatDuration, type Heartbeat, type HeartbeatSpec } from './watchdog.js';
import { Metrics } from './metrics.js';
import { FloodControl, summaryTitle, type FloodSummary } from './flood.js';
import { PushSender } from './push.js';
import { renderQr } from './qr.js';

export interface NotifyInput {
  channel?: string;
  severity?: Severity;
  title: string;
  body?: string;
  tags?: string[];
  data?: Record<string, unknown>;
  actions?: NotificationAction[];
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
  private readonly push: PushSender;
  private readonly watchdog: Watchdog;
  private readonly metrics = new Metrics();
  private readonly sessions = new Map<string, Session>();
  /** deviceId -> sessions. A device may legitimately hold more than one. */
  private readonly byDevice = new Map<string, Set<Session>>();
  private readonly ackWaiters = new Map<string, NodeJS.Timeout>();

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
    this.guard = new Guard(this.opts.security, this.store);
    this.calls = new CallOrchestrator(this.opts.defaultRingSeconds, (e) => {
      this.emit('call', e);
      this.audit(`call.${e.type}`, { detail: { callId: e.callId } });
    });
    this.flood = new FloodControl(this.opts.flood, (summary) => this.releaseSummary(summary));
    this.push = new PushSender(this.opts.push, this.opts.logger, (ok, count) =>
      this.metrics.pushed(ok, count),
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
    const beat = this.watchdog.expect(name, spec);
    this.store.putHeartbeat(beat);
    this.audit('heartbeat.expected', { detail: { name, every: beat.every } });
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
    for (const session of this.sessions.values()) {
      if (session.state !== 'ready') continue;
      session.send({ v: PROTOCOL_VERSION, t: 'resolve', ids, key: spec.key });
      for (const id of ids) session.pending.delete(id);
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

  upsertPolicy(policy: EscalationPolicy): void {
    if (!policy.name || !Array.isArray(policy.steps) || policy.steps.length === 0) {
      throw new Error('an escalation policy needs a name and at least one step');
    }
    this.store.putPolicy(policy);
    this.audit('policy.upsert', { detail: { name: policy.name, steps: policy.steps.length } });
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
    if (!this.push.enabled) return;
    const online = new Set(this.opts.push.evenWhenOnline ? [] : deliveredTo);

    const targets = this.store.devices().filter((device) => {
      if (!device.pushToken || device.status !== 'active') return false;
      if (online.has(device.id)) return false;
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

    await this.push.notify(targets, n);
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

    await new Promise<void>((res, rej) => {
      this.http!.once('error', rej);
      this.http!.listen(this.opts.port, this.opts.host, () => {
        this.http!.off('error', rej);
        res();
      });
    });

    if (this.opts.deviceWatchdog.enabled) {
      this.beatTimer = setInterval(() => this.beat(), this.opts.deviceWatchdog.intervalMs);
      this.beatTimer.unref?.();
    }

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

    for (const session of [...this.sessions.values()]) session.close(1001, 'shutting down');
    this.sessions.clear();
    this.byDevice.clear();

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
    if (!this.push.enabled) return;
    const online = new Set(ringing);
    const targets = this.store.devices().filter((device) => {
      if (!device.pushToken || device.status !== 'active' || online.has(device.id)) return false;
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
    await this.push.call(targets, req);
  }

  private beat(): void {
    const ts = Date.now();
    for (const session of this.sessions.values()) {
      if (session.state !== 'ready') continue;
      session.send({ v: PROTOCOL_VERSION, t: 'beat', ts });
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
      allowIps: Array.isArray(input.allowIps)
        ? input.allowIps.filter((ip) => typeof ip === 'string').slice(0, 50)
        : undefined,
      label: typeof input.label === 'string' ? input.label.slice(0, 64) : undefined,
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
    return this.store.updateDevice(deviceId, { name: name.slice(0, 64) });
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
        'content-type': MIME[extname(target)] ?? 'application/octet-stream',
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

    this.wss!.handleUpgrade(req, socket, head, (ws) => {
      this.openSession(ws, ip, origin);
    });
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

  private clientIp(req: IncomingMessage): string {
    if (this.opts.security.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0];
      // Only an actual address is honoured. The header is client-supplied, so
      // an unvalidated value lets a peer invent a new identity per request and
      // walk straight past the per-IP rate limit and every ban ever issued.
      const candidate = first ? normalizeIp(first) : undefined;
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
    });

    ws.on('message', (raw, isBinary) => {
      this.handleMessage(session, raw as Buffer, isBinary).catch((err) => {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
        session.close(1011, 'internal error');
      });
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

    if (record.allowIps && !record.allowIps.includes(session.ip)) {
      return rejectAndRelease('ip_not_allowed');
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
    const shown = eligible.length > limit ? eligible.slice(-limit) : eligible;
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
      if (n.requireAck) session.pending.add(n.id);
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
    for (const id of ids) {
      session.pending.delete(id);
      this.emit('ack', { notificationId: id, deviceId: session.device.id, action: msg.action });
      // One acknowledgement is enough: a human has seen it, so stop retrying.
      const timer = this.ackWaiters.get(id);
      if (timer) {
        clearTimeout(timer);
        this.ackWaiters.delete(id);
      }
    }
    // Clamped to what the hub has actually issued: a device that reported a
    // cursor from the future - a bug, a bad clock, a hostile client - would
    // silently opt itself out of every replay from then on.
    if (Number.isFinite(msg.seq) && (msg.seq as number) > session.device.ackedSeq) {
      const seq = Math.min(msg.seq as number, this.store.seq);
      if (seq > session.device.ackedSeq) {
        const updated = this.store.updateDevice(session.device.id, { ackedSeq: seq });
        if (updated) session.device = updated;
      }
    }
  }

  /** A device offering (or withdrawing) a wake-up token for itself. */
  private handlePushRegister(
    session: Session,
    msg: Extract<ClientMessage, { t: 'push.register' }>,
  ): void {
    if (!session.device) return;
    const token = typeof msg.token === 'string' ? msg.token.slice(0, 256) : '';

    const updated = this.store.updateDevice(session.device.id, {
      pushToken: token || undefined,
      pushProvider: token ? 'expo' : undefined,
    });
    if (updated) session.device = updated;
    this.audit(token ? 'push.registered' : 'push.cleared', { deviceId: session.device.id });
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
    const reply = (ok: boolean, data?: unknown, error?: string) =>
      session.send({ v: PROTOCOL_VERSION, t: 'admin.result', id: msg.id, ok, data, error });

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
        case 'roles.list':
          return reply(true, { roles: this.roles() });
        case 'roles.upsert':
          // A role may only carry the privileged capabilities its author
          // already holds. Blocking `admin` alone was not enough:
          // `devices.manage` mints pairing codes and `roles.manage` writes the
          // role they point at, so either one composes back into admin.
          this.upsertRole(sanitizeRole(args, role.capabilities));
          return reply(true, { roles: this.roles() });
        case 'roles.delete':
          return reply(true, { deleted: this.deleteRole(String(args.name)) });
        case 'notify.send':
          void this.notify(args as NotifyInput).catch(() => {});
          return reply(true, {});
        case 'call.place':
          void this.call(args as CallInput).catch(() => {});
          return reply(true, {});
        case 'notify.resolve':
          // Awaited: replying with the promise itself serialises to `{}`, so
          // every caller was told nothing had been resolved.
          return reply(true, { resolved: await this.resolve(args as { id?: string; key?: string }) });
        case 'heartbeats.list':
          return reply(true, { heartbeats: this.heartbeats() });
        case 'heartbeat.expect':
          return reply(true, {
            heartbeat: this.expect(String(args.name), args as unknown as HeartbeatSpec),
          });
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
      to: input.to,
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
      message: String(input.message ?? '').slice(0, 2000),
      lang: input.lang,
      rate: input.rate,
      pitch: input.pitch,
      ringSeconds: input.ringSeconds ?? this.opts.defaultRingSeconds,
      repeat: input.repeat,
      to: input.to,
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

    // A snoozed device still gets critical alerts: the point is to quiet
    // noise, not to disable the pager.
    const snoozed = session.device.snoozedUntil ?? 0;
    if (snoozed > Date.now() && severity !== 'critical') return false;

    return canDeliver({
      role: session.role,
      deviceId: session.device.id,
      channel,
      severity,
      to,
      isCall,
    });
  }

  private deliver(n: Notification): string[] {
    const reached = new Set<string>();
    for (const session of this.sessions.values()) {
      if (session.state !== 'ready' || !session.device) continue;
      if (!this.allowed(session, n.channel, n.severity, n.to, false)) continue;
      session.send({ v: PROTOCOL_VERSION, t: 'notification', n });
      if (n.requireAck) session.pending.add(n.id);
      // A device may hold several sockets; it is still one device reached.
      reached.add(session.device.id);
    }
    return [...reached];
  }

  /**
   * Re-sends an unacknowledged notification until somebody acks it, its TTL
   * runs out, or we hit the attempt ceiling. This is what makes `requireAck`
   * mean "a person saw this" rather than "a socket was open at the time".
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
    // Most recently seen device first: the phone in someone's hand should ring
    // before the tablet that has been on a shelf since Tuesday.
    return targets.sort(
      (a, b) =>
        (this.store.device(b.deviceId)?.lastSeenAt ?? 0) -
        (this.store.device(a.deviceId)?.lastSeenAt ?? 0),
    );
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

/** Stamped in at bundle time; falls back for source checkouts. */
const NOTIFYJS_VERSION = process.env.NOTIFYJS_VERSION ?? '0.1.0';

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

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/** Least privilege per admin op; `admin` satisfies all of them implicitly. */
const ADMIN_CAPABILITY: Record<string, Capability> = {
  'devices.list': 'devices.manage',
  'devices.revoke': 'devices.manage',
  'devices.rename': 'devices.manage',
  'devices.setRole': 'devices.manage',
  'pair.create': 'devices.manage',
  'pair.list': 'devices.manage',
  'pair.revoke': 'devices.manage',
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
};

/** A valid, throwaway key used to keep failed-auth timing flat. */
const DECOY_PUBLIC_KEY = 'BdC4l3lXbNIqjRfjP8ycxHDCiMMVBpjs7ymEQR8lPFY';

function randomId(bytes: number): string {
  return toBase64Url(nodeCrypto.randomBytes(bytes));
}

/** Whether a device satisfies an explicit role/device restriction. */
function matchesTargeting(to: Targeting, deviceId: string, role: string): boolean {
  if (to.devices?.length && !to.devices.includes(deviceId)) return false;
  if (to.roles?.length && !to.roles.includes(role)) return false;
  return true;
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
