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
  /**
   * When set, only these addresses may connect at all.
   *
   * Each entry is a bare address or a CIDR range (`'10.0.0.5'`,
   * `'10.0.0.0/24'`, `'2001:db8::/32'`). An entry that is neither is refused
   * when the hub is constructed rather than quietly matching nothing.
   */
  allowIps?: string[];
  /** Always refused, checked before anything else. Same forms as `allowIps`. */
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
 * Acting on a notification, off by default.
 *
 * A notification can carry buttons, and a device pressing one produces an
 * `action` event for the application that published it. That is a far bigger
 * thing than an acknowledgement: acknowledging says a person saw an alert,
 * acting asks the system that raised it to do something. So it is opt-in, it
 * needs its own capability that no stock role carries, and each action can be
 * taken once.
 *
 * The hub never fetches anything a notification names. An action is delivered
 * as an event and the application decides what it means - anything else would
 * be a request forgery primitive with the callback chosen by whoever could
 * publish.
 */
export interface ActionsOptions {
  enabled: boolean;
}

/**
 * Publishing over HTTP, off by default and deliberately so.
 *
 * Every other publisher proves itself by signing a per-connection nonce, and
 * nothing reusable crosses the wire. A bearer token is weaker than that: it is
 * replayable, it sits in somebody's CI settings, and it travels in a header.
 * That is a real trade against the rest of this design - so it is opt-in, the
 * token carries only a role's permissions rather than being all-powerful, and
 * it is refused outright over plain HTTP to anything but a loopback address.
 */
export interface IngestOptions {
  enabled: boolean;
  /**
   * Accept tokens over a non-TLS connection from somewhere other than this
   * machine. A bearer token on a cleartext link is readable by every hop it
   * crosses, so this stays off and the hub answers 421 instead.
   */
  allowInsecure: boolean;
  /** Largest request body accepted, in bytes. */
  maxBodyBytes: number;
  /** Requests per minute per token, before the hub starts refusing. */
  ratePerMinute: number;
}

/**
 * Web Push - for browsers, for an iPhone on its home screen, and now the only
 * way this hub wakes a device that is not connected.
 *
 * It is on by default, which nothing else that leaves the hub is, and the
 * reason is the payload: it is encrypted to a key the browser generated
 * (RFC 8291), so the push service forwards bytes it cannot read. The service
 * is also the browser vendor's own rather than one this project picked, and
 * nothing is sent until somebody has clicked "enable" in a specific browser -
 * a stronger opt-in than any server flag.
 *
 * That is the bargain the Expo transport could not make, and why it is gone:
 * it handed a third party the notification title in the clear on every alert.
 */
export interface WebPushOptions {
  enabled: boolean;
  /**
   * Include the notification body, not just its title.
   *
   * Used to live on the Expo options and be shared with this one, on the
   * reasoning that what leaves the hub should be answered once. With the Expo
   * transport gone there is only one push transport left, so the decision
   * lives where it applies. It matters less here than it did there: the
   * payload is encrypted to the browser's own key, so the push service
   * forwards bytes it cannot read either way.
   */
  includeBody: boolean;
  /** Also push when a device *is* connected. Usually redundant. */
  evenWhenOnline: boolean;
  /**
   * The VAPID `sub` claim - a `mailto:` or `https:` URI identifying whoever
   * runs this hub, which a push service uses to contact you if it becomes a
   * problem. Required by RFC 8292 and rejected by Apple if it is neither.
   */
  subject: string;
  /** How long a push service holds a message for a browser that is offline. */
  ttlSeconds: number;
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
  /** Publishing over HTTP with a bearer token. See `IngestOptions`. */
  ingest?: Partial<IngestOptions>;
  /** Acting on a notification's buttons. See `ActionsOptions`. */
  actions?: Partial<ActionsOptions>;
  /** Encrypted pushes to browsers, including iOS. See `WebPushOptions`. */
  webPush?: Partial<WebPushOptions>;
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
      | 'ingest'
      | 'actions'
      | 'webPush'
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
  ingest: IngestOptions;
  actions: ActionsOptions;
  webPush: WebPushOptions;
  deviceWatchdog: DeviceWatchdogOptions;
  logger: (line: string, meta?: Record<string, unknown>) => void;
}

/**
 * Refuses a number that would quietly switch off the thing it configures.
 *
 * `port: 70000` used to validate cleanly, print cleanly, and then fail at bind
 * time with a `RangeError` from inside Node. The quieter ones never failed at
 * all: `historyLimit: 0` - a plausible way to write "keep nothing" - made
 * `readTail` return the entire file on load and then had the next notification
 * splice the whole cache away, so replay to a device coming back from offline
 * silently delivered nothing, for ever, with no error anywhere. A
 * `heartbeatTickMs` of 0 is a `setInterval` with no gap in it.
 *
 * Checked here, where an operator who mistyped a value is still reading output.
 */
function bounded(
  option: string,
  value: unknown,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  // A numeric string is accepted and converted. The types say `number`, but this
  // library is imported from plain JavaScript - the examples in this repository
  // are - and `new Notifier({ port: process.env.PORT })` worked before this
  // validation existed, because `listen('8080')` is valid. Refusing it would have
  // been a new failure introduced by a fix. An empty string is not a number and
  // is refused: read as one it would mean "any free port", which is a hub nobody
  // can be told the address of.
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;

  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${option} must be between ${min} and ${max}, not ${JSON.stringify(value)}`);
  }
  // Whole numbers throughout: these are ports, counts and milliseconds, and a
  // fractional one only ever arrives from a bad division.
  return Math.floor(n);
}

/**
 * Refuses a boolean that is not one.
 *
 * `security: { trustProxy: process.env.TRUST_PROXY }` with that variable set to
 * `'false'` is a truthy string, and what it switched on was reading the client's
 * address out of a request header - so both IP lists, every ban and the
 * per-address connection limit became a line the caller could write for
 * themselves. The same spelling turns HTTP publishing on, or the device watchdog
 * off.
 *
 * The strings are accepted because an option wired from a configuration file or
 * an environment variable arrives as one, exactly as `bounded` accepts a numeric
 * string. Anything that is neither answer is refused rather than guessed at.
 */
function flag(option: string, value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  // 1 and 0 are the two numbers that are not a guess, and both worked when this
  // was a plain truthiness test, so refusing them would be a fault introduced by
  // a fix. Any other number is refused along with the rest.
  if (value === 1) return true;
  if (value === 0) return false;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
    if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  }
  throw new Error(`${option} must be true or false, not ${JSON.stringify(value)}`);
}

/** Applies `flag` to the named fields of an already-merged group of options. */
function flags<T>(prefix: string, group: T, keys: readonly (keyof T & string)[]): T {
  const bag = group as Record<string, unknown>;
  for (const key of keys) bag[key] = flag(prefix + key, bag[key]);
  return group;
}

/**
 * Drops keys whose value is `undefined`, so a spread cannot erase a default.
 *
 * `{ ...defaults, ...caller }` copies an explicit `undefined` over the value
 * beneath it, and an application wiring its options from its own configuration
 * produces exactly that: `{ intervalMs: cfg.watchdogMs }` with that key unset
 * replaced a working default with nothing. For the device watchdog the result
 * was shipped to every paired device, where the numbers it needs became
 * `setTimeout(NaN)`.
 */
function defined<T extends object>(o: T | undefined): Partial<T> {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function resolveOptions(o: NotifierOptions = {}): ResolvedOptions {
  const log = o.logger === false ? () => {} : o.logger ?? defaultLogger;
  return {
    port: bounded('port', o.port ?? DEFAULT_PORT, 0, 65535),
    host: o.host ?? '0.0.0.0',
    name: o.name ?? 'NotifyJS',
    storeDir: o.storeDir ?? '.notifyjs',
    dashboard: flag('dashboard', o.dashboard ?? true),
    dashboardDir: o.dashboardDir,
    tls: o.tls,
    historyLimit: bounded('historyLimit', o.historyLimit ?? 500, 1),
    auditLimit: bounded('auditLimit', o.auditLimit ?? 1000, 1),
    ackRetryMs: bounded('ackRetryMs', o.ackRetryMs ?? 30_000, 100),
    defaultRingSeconds: bounded('defaultRingSeconds', o.defaultRingSeconds ?? 30, 1, 600),
    replayLimit: bounded('replayLimit', o.replayLimit ?? 50, 0),
    heartbeatTickMs: bounded('heartbeatTickMs', o.heartbeatTickMs ?? 5_000, 1),
    // Matches the device watchdog's own cadence, so a hub with both on sends
    // one frame and one ping on the same tick rather than two timers' worth.
    livenessIntervalMs: Math.max(
      1_000,
      o.livenessIntervalMs ?? o.deviceWatchdog?.intervalMs ?? 30_000,
    ),
    metrics: flag('metrics', o.metrics ?? true),
    metricsToken: o.metricsToken,
    publicUrl: o.publicUrl,
    logger: log,
    deviceWatchdog: flags(
      'deviceWatchdog.',
      {
        // On by default: the failure it catches is the one that matters most,
        // and it costs one small frame every 30 seconds per device.
        enabled: true,
        intervalMs: 30_000,
        graceMs: 30_000,
        severity: 'critical' as Severity,
        ...defined(o.deviceWatchdog),
      },
      ['enabled'],
    ),
    flood: flags(
      'flood.',
      {
        enabled: true,
        windowMs: 60_000,
        burst: 5,
        alwaysDeliver: ['critical'] as Severity[],
        ...defined(o.flood),
      },
      ['enabled'],
    ),
    actions: flags('actions.', { enabled: false, ...defined(o.actions) }, ['enabled']),
    ingest: flags(
      'ingest.',
      {
        enabled: false,
        allowInsecure: false,
        // Enough for a verbose Alertmanager group, far short of anything worth
        // buffering from an unauthenticated caller.
        maxBodyBytes: 64 * 1024,
        ratePerMinute: 120,
        ...defined(o.ingest),
      },
      ['enabled', 'allowInsecure'],
    ),
    webPush: flags(
      'webPush.',
      {
        enabled: true,
        includeBody: false,
        evenWhenOnline: false,
        subject: 'https://github.com/OSQD-ts/NotifyJS',
        // Four hours. Long enough to survive a closed laptop over lunch, short
        // enough that a pager alert never arrives stale enough to mislead.
        ttlSeconds: 4 * 60 * 60,
        ...defined(o.webPush),
      },
      ['enabled', 'includeBody', 'evenWhenOnline'],
    ),
    security: flags(
      'security.',
      {
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
        clockSkewMs: 60_000,
        maxBufferedBytes: 1024 * 1024,
        allowedOrigins: 'same-origin' as SecurityOptions['allowedOrigins'],
        trustProxy: false,
        uniformFailureMs: 250,
        ...defined(o.security),
        // After the spread, and merged rather than replaced: this is the one
        // nested object in here, and a caller supplying just one of its two
        // fields would otherwise lose the other to `undefined`.
        messageRate: {
          points: 60,
          windowMs: 10_000,
          ...defined(o.security?.messageRate),
        },
      },
      ['trustProxy'],
    ),
  };
}

function defaultLogger(line: string, meta?: Record<string, unknown>): void {
  const suffix = meta && Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  process.stdout.write(`[notifyjs] ${line}${suffix}\n`);
}
