import { DEFAULT_PORT, type Severity } from '@osqd/notifyjs-protocol';

/**
 * Brute-force defences. The hub is expected to sit on a port that is open to
 * the internet, so every one of these defaults assumes hostile traffic and has
 * to be *loosened* deliberately rather than tightened.
 */
export interface SecurityOptions {
  /** Concurrent sockets allowed from one IP. NAT means this is not 1. */
  maxConnectionsPerIp: number;
  /** Token bucket over new connections per IP: burst size and refill rate. */
  connectionBurst: number;
  connectionRefillPerSec: number;
  /** Ceiling on sockets that have not authenticated yet, hub-wide. */
  maxUnauthenticated: number;
  /** A socket that has not paired or authenticated by then is dropped. */
  handshakeTimeoutMs: number;
  /** Failed pair/auth attempts from one IP before it is banned. */
  maxFailuresBeforeBan: number;
  /** Failures older than this stop counting toward a ban. */
  failureWindowMs: number;
  /** First ban length. Each repeat ban doubles it, up to `banMaxMs`. */
  banBaseMs: number;
  banMaxMs: number;
  /** Frames larger than this are dropped and the sender is disconnected. */
  maxMessageBytes: number;
  /** Post-auth flood control: `points` frames per `windowMs`. */
  messageRate: { points: number; windowMs: number };
  /** Tolerated clock difference on signed `auth` timestamps. */
  clockSkewMs: number;
  /**
   * Outbound bytes allowed to queue for one device before it is disconnected.
   * Guards against an authenticated peer that never drains its socket.
   */
  maxBufferedBytes: number;
  /** When set, only these IPs may connect at all. */
  allowIps?: string[];
  /** Always refused, checked before anything else. */
  denyIps?: string[];
  /**
   * Browser `Origin` values accepted on upgrade.
   *
   * `'same-origin'` (the default) accepts only an Origin whose host matches
   * the request's Host header, which is what the hub's own dashboard always
   * sends. `'*'` disables the check, allowing any site your browser visits to
   * open a socket to a hub on your network. Non-browser clients send no
   * Origin and are unaffected either way.
   */
  allowedOrigins: string[] | '*' | 'same-origin';
  /** Read the client IP from `X-Forwarded-For`. Only behind your own proxy. */
  trustProxy: boolean;
  /** Floor on how long a rejected handshake takes, to flatten timing signal. */
  uniformFailureMs: number;
}

/**
 * Collapses repeated identical alerts.
 *
 * A service in a crash loop can call `notify.error()` a thousand times a
 * minute, and without this every device buzzes a thousand times. Nothing is
 * ever dropped: once a key exceeds its burst the extras are counted and
 * released as a single summary when the window closes.
 */
export interface FloodOptions {
  enabled: boolean;
  /** Window over which repeats of one key are counted. */
  windowMs: number;
  /** Notifications per key delivered normally before coalescing starts. */
  burst: number;
  /**
   * Severities that bypass coalescing entirely. A critical alert is exactly
   * the thing that must never wait for a summary window.
   */
  alwaysDeliver: Severity[];
}

/**
 * Wake-up pushes, off by default and deliberately so.
 *
 * A device only receives while its socket is open, which on a phone means
 * while the app is running. Enabling this lets the hub ask a push service to
 * wake a device that is not connected - and that means the notification title
 * leaves your infrastructure and passes through Expo, Apple or Google. That is
 * a real trade against the rest of this design, so it is opt-in and the body
 * is withheld unless you ask for it.
 */
export interface PushOptions {
  enabled: boolean;
  /** Expo's push endpoint. Override to route through your own relay. */
  endpoint: string;
  /** Include the notification body, not just its title. */
  includeBody: boolean;
  /** Also push when a device *is* connected. Usually redundant. */
  evenWhenOnline: boolean;
}

/**
 * Turns every paired device into a watchdog for this hub.
 *
 * An embedded hub cannot report its own death - it dies with the process. But
 * the phones and laptops already holding a socket to it can notice the silence
 * and say so locally, with no third party involved. The hub declares the
 * contract when a device connects: how often it will be heard from, and what
 * to say if it stops.
 *
 * A device can only ever prove that *it* stopped hearing the service, so the
 * alert is worded as such and is withheld when the device knows its own
 * network is down.
 */
export interface DeviceWatchdogOptions {
  enabled: boolean;
  /** How often the hub sends proof of life. */
  intervalMs: number;
  /** Extra silence a device tolerates before raising the alarm. */
  graceMs: number;
  /** Title of the alert the device raises. Defaults to the hub's name. */
  title?: string;
  body?: string;
  severity: Severity;
}

export interface NotifierOptions {
  /**
   * Port for the WebSocket hub and the dashboard. `0` takes any free port,
   * which `url`, `publicUrl` and the `listening` event then report back.
   */
  port?: number;
  host?: string;
  /** Shown to devices during pairing so the user knows what they joined. */
  name?: string;
  /** Directory holding `store.json`. Created with 0700 if missing. */
  storeDir?: string;
  /** Serve the bundled dashboard over HTTP on the same port. */
  dashboard?: boolean;
  /** Path to alternative dashboard assets. */
  dashboardDir?: string;
  /**
   * The address devices should use to reach this hub, e.g.
   * `ws://192.168.1.10:7741`. Used in pairing links and QR codes. Detected
   * from the machine's LAN address when omitted.
   */
  publicUrl?: string;
  /** Terminate TLS in-process. Otherwise put the hub behind a proxy. */
  tls?: { cert: string | Buffer; key: string | Buffer; ca?: string | Buffer };
  /** Notifications kept for replay to devices that were offline. */
  historyLimit?: number;
  /** Audit entries retained in the store. */
  auditLimit?: number;
  /** How often an unacknowledged `requireAck` notification is re-sent. */
  ackRetryMs?: number;
  /** Default ring duration for `call()` when the request does not say. */
  defaultRingSeconds?: number;
  /**
   * Most notifications replayed to a device returning from offline. Beyond
   * this it receives the newest few plus a summary, rather than a burst of
   * hundreds.
   */
  replayLimit?: number;
  /**
   * How often overdue heartbeats are checked for. Lower it when watching
   * check-ins that are expected more often than once a minute.
   */
  heartbeatTickMs?: number;
  /**
   * How often the hub checks that each connected device is still reachable,
   * and how often it sends proof of life when `deviceWatchdog` is on.
   *
   * A socket can be dead without being closed, and nothing else notices: TCP
   * takes many minutes, and on a quiet connection may never. Until then the hub
   * counts that device as reached and an escalating call rings it.
   */
  livenessIntervalMs?: number;
  /** Serve Prometheus counters at `/metrics`. */
  metrics?: boolean;
  /** Require `Authorization: Bearer <token>` on `/metrics`. */
  metricsToken?: string;
  /** Let paired devices raise the alarm if this hub goes quiet. */
  deviceWatchdog?: Partial<DeviceWatchdogOptions>;
  /** Collapses repeated identical alerts. See `FloodOptions`. */
  flood?: Partial<FloodOptions>;
  /** Wake-up pushes for devices that are not connected. See `PushOptions`. */
  push?: Partial<PushOptions>;
  security?: Partial<SecurityOptions>;
  /** Print pairing codes and lifecycle lines to stdout. */
  logger?: ((line: string, meta?: Record<string, unknown>) => void) | false;
}

export interface ResolvedOptions
  extends Required<
    Omit<
      NotifierOptions,
      | 'tls'
      | 'security'
      | 'logger'
      | 'dashboardDir'
      | 'flood'
      | 'push'
      | 'publicUrl'
      | 'metricsToken'
      | 'deviceWatchdog'
    >
  > {
  tls?: NotifierOptions['tls'];
  dashboardDir?: string;
  publicUrl?: string;
  metricsToken?: string;
  security: SecurityOptions;
  flood: FloodOptions;
  push: PushOptions;
  deviceWatchdog: DeviceWatchdogOptions;
  logger: (line: string, meta?: Record<string, unknown>) => void;
}

export function resolveOptions(o: NotifierOptions = {}): ResolvedOptions {
  const log = o.logger === false ? () => {} : o.logger ?? defaultLogger;
  return {
    port: o.port ?? DEFAULT_PORT,
    host: o.host ?? '0.0.0.0',
    name: o.name ?? 'NotifyJS',
    storeDir: o.storeDir ?? '.notifyjs',
    dashboard: o.dashboard ?? true,
    dashboardDir: o.dashboardDir,
    tls: o.tls,
    historyLimit: o.historyLimit ?? 500,
    auditLimit: o.auditLimit ?? 1000,
    ackRetryMs: o.ackRetryMs ?? 30_000,
    defaultRingSeconds: o.defaultRingSeconds ?? 30,
    replayLimit: o.replayLimit ?? 50,
    heartbeatTickMs: o.heartbeatTickMs ?? 5_000,
    // Matches the device watchdog's own cadence, so a hub with both on sends
    // one frame and one ping on the same tick rather than two timers' worth.
    livenessIntervalMs: Math.max(
      1_000,
      o.livenessIntervalMs ?? o.deviceWatchdog?.intervalMs ?? 30_000,
    ),
    metrics: o.metrics ?? true,
    metricsToken: o.metricsToken,
    publicUrl: o.publicUrl,
    logger: log,
    deviceWatchdog: {
      // On by default: the failure it catches is the one that matters most,
      // and it costs one small frame every 30 seconds per device.
      enabled: true,
      intervalMs: 30_000,
      graceMs: 30_000,
      severity: 'critical',
      ...o.deviceWatchdog,
    },
    flood: {
      enabled: true,
      windowMs: 60_000,
      burst: 5,
      alwaysDeliver: ['critical'],
      ...o.flood,
    },
    push: {
      enabled: false,
      endpoint: 'https://exp.host/--/api/v2/push/send',
      includeBody: false,
      evenWhenOnline: false,
      ...o.push,
    },
    security: {
      maxConnectionsPerIp: 10,
      connectionBurst: 10,
      connectionRefillPerSec: 0.5,
      maxUnauthenticated: 100,
      handshakeTimeoutMs: 10_000,
      maxFailuresBeforeBan: 5,
      failureWindowMs: 15 * 60_000,
      banBaseMs: 60_000,
      banMaxMs: 24 * 60 * 60_000,
      maxMessageBytes: 64 * 1024,
      messageRate: { points: 60, windowMs: 10_000 },
      clockSkewMs: 60_000,
      maxBufferedBytes: 1024 * 1024,
      allowedOrigins: 'same-origin',
      trustProxy: false,
      uniformFailureMs: 250,
      ...o.security,
    },
  };
}

function defaultLogger(line: string, meta?: Record<string, unknown>): void {
  const suffix = meta && Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  process.stdout.write(`[notifyjs] ${line}${suffix}\n`);
}
