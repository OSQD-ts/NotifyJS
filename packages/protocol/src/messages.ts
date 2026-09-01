import type { PROTOCOL_VERSION } from './version.js';
import type {
  Capability,
  CallRequest,
  CallOutcome,
  Device,
  EscalationPolicy,
  Heartbeat,
  Notification,
  PairingCode,
  Role,
  AuditEvent,
  WebPushKeys,
} from './types.js';

/**
 * Every frame on the wire is a JSON object with a `v` (protocol version) and a
 * `t` (type) discriminant. Unknown types are ignored rather than fatal, so a
 * newer hub can add frames without breaking older clients.
 */
export interface Envelope {
  v: typeof PROTOCOL_VERSION;
  t: string;
}

/* ------------------------------------------------------------------ */
/* Server -> client                                                    */
/* ------------------------------------------------------------------ */

/**
 * First frame on every connection. The `nonce` is single-use and bound to this
 * socket, which is what makes a captured `auth` frame worthless on replay.
 */
export interface HelloMsg extends Envelope {
  t: 'hello';
  serverId: string;
  serverName: string;
  nonce: string;
  serverTime: number;
  /** Seconds the client has to complete pair/auth before it is disconnected. */
  handshakeTimeout: number;
}

export interface PairedMsg extends Envelope {
  t: 'paired';
  deviceId: string;
  role: string;
  capabilities: Capability[];
}

export interface ReadyMsg extends Envelope {
  t: 'ready';
  deviceId: string;
  deviceName: string;
  role: string;
  capabilities: Capability[];
  /** Highest sequence the hub holds, so the client knows how far to sync. */
  seq: number;
  serverTime: number;
  /**
   * VAPID application server key, base64url, for `pushManager.subscribe`.
   *
   * Sent here rather than fetched from an endpoint of its own: a browser only
   * needs it once it is a paired device, and this frame is already the answer
   * to "you are authenticated, here is what this hub can do". Absent when Web
   * Push is turned off, which is also how the dashboard knows not to offer it.
   */
  vapidPublicKey?: string;
}

export interface NotificationMsg extends Envelope {
  t: 'notification';
  n: Notification;
}

export interface CallMsg extends Envelope {
  t: 'call';
  c: CallRequest;
}

/** Sent when another device answered first, or the caller cancelled. */
export interface CallCancelMsg extends Envelope {
  t: 'call.cancel';
  callId: string;
  reason: CallOutcome | 'taken';
}

/**
 * Tells a device to watch the hub, rather than the other way round.
 *
 * An embedded hub dies with the process it lives in, so it cannot report its
 * own death. The devices already holding a socket to it can: the hub declares
 * how often it will be heard from and what to say if it goes quiet, and each
 * device arms a local timer. No third party required - the watchers are the
 * phones and laptops you already paired.
 */
export interface WatchdogMsg extends Envelope {
  t: 'watchdog';
  enabled: boolean;
  /** How often the hub promises to be heard from. */
  intervalMs: number;
  /** Extra silence tolerated before the device raises the alarm. */
  graceMs: number;
  /** What the device should say. Written by the hub, which knows what it is. */
  alert: { title: string; body?: string; severity: string };
}

/**
 * Proof of life, pushed by the hub. Any inbound frame resets a device's timer;
 * this exists so a quiet hub still produces traffic.
 */
export interface BeatMsg extends Envelope {
  t: 'beat';
  ts: number;
}

/**
 * A planned shutdown. Without this every deploy would page whoever is on call,
 * which is how people learn to ignore the alarm.
 */
export interface ByeMsg extends Envelope {
  t: 'bye';
  reason: string;
  /** Silence expected for roughly this long. Zero means "no idea". */
  expectedDowntimeMs: number;
}

/** Clears notifications whose condition has ended. */
export interface ResolveMsg extends Envelope {
  t: 'resolve';
  ids: string[];
  key?: string;
}

/** The hub revoked this device; the client must discard its keypair. */
export interface RevokedMsg extends Envelope {
  t: 'revoked';
  reason: string;
}

export interface AdminResultMsg extends Envelope {
  t: 'admin.result';
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface ErrorMsg extends Envelope {
  t: 'error';
  /** Coarse machine-readable code. Deliberately vague on auth failures. */
  code: string;
  message: string;
  /** Present on rate-limit rejections: seconds until the client may retry. */
  retryAfter?: number;
}

export interface PongMsg extends Envelope {
  t: 'pong';
  ts: number;
}

export type ServerMessage =
  | HelloMsg
  | PairedMsg
  | ReadyMsg
  | NotificationMsg
  | CallMsg
  | CallCancelMsg
  | ResolveMsg
  | WatchdogMsg
  | BeatMsg
  | ByeMsg
  | RevokedMsg
  | AdminResultMsg
  | ErrorMsg
  | PongMsg;

/* ------------------------------------------------------------------ */
/* Client -> server                                                    */
/* ------------------------------------------------------------------ */

export interface PairMsg extends Envelope {
  t: 'pair';
  code: string;
  /** Raw Ed25519 public key, base64url. Generated on-device, never leaves it. */
  publicKey: string;
  name: string;
  platform: string;
  model?: string;
  /** Signature over the pair transcript, proving possession of the key. */
  sig: string;
}

export interface AuthMsg extends Envelope {
  t: 'auth';
  deviceId: string;
  ts: number;
  /** Signature over the auth transcript, including the server nonce. */
  sig: string;
}

export interface AckMsg extends Envelope {
  t: 'ack';
  ids: string[];
  /** Advances the device's delivery cursor. */
  seq?: number;
  /** Set when the user pressed one of the notification's actions. */
  action?: string;
}

export interface SyncMsg extends Envelope {
  t: 'sync';
  since: number;
}

export interface CallReplyMsg extends Envelope {
  t: 'call.reply';
  callId: string;
  outcome: Extract<CallOutcome, 'answered' | 'declined'>;
}

export interface CallEndedMsg extends Envelope {
  t: 'call.ended';
  callId: string;
}

export interface AdminMsg extends Envelope {
  t: 'admin';
  id: string;
  op: AdminOp;
  args?: Record<string, unknown>;
}

export interface PingMsg extends Envelope {
  t: 'ping';
  ts: number;
}

/**
 * Silences this device for a while. `untilMs` of 0 cancels an active snooze.
 */
export interface SnoozeMsg extends Envelope {
  t: 'snooze';
  untilMs: number;
}

/**
 * Registers a wake-up token so the hub can reach this device while its socket
 * is closed. Sending an empty token withdraws consent and clears it.
 */
export interface PushRegisterMsg extends Envelope {
  t: 'push.register';
  /** An Expo push token, or a Web Push subscription endpoint. Empty clears it. */
  token: string;
  provider: 'expo' | 'webpush';
  /** Required for `webpush`, meaningless for `expo`. */
  keys?: WebPushKeys;
}

export type ClientMessage =
  | PairMsg
  | AuthMsg
  | AckMsg
  | SyncMsg
  | CallReplyMsg
  | CallEndedMsg
  | AdminMsg
  | PingMsg
  | PushRegisterMsg
  | SnoozeMsg;

export type AdminOp =
  | 'devices.list'
  | 'devices.revoke'
  | 'devices.rename'
  | 'devices.setRole'
  | 'pair.create'
  | 'pair.list'
  | 'pair.revoke'
  | 'roles.list'
  | 'roles.upsert'
  | 'roles.delete'
  | 'notify.send'
  | 'call.place'
  | 'audit.tail'
  | 'history'
  | 'notify.resolve'
  | 'heartbeats.list'
  | 'heartbeat.expect'
  | 'heartbeat.checkin'
  | 'heartbeat.forget'
  | 'policies.list'
  | 'policies.upsert'
  | 'policies.delete'
  | 'metrics';

/**
 * What each `admin` op resolves to.
 *
 * The single description of the hub's admin replies, so the CLI, dashboard and
 * desktop app stop each hand-writing their own. That duplication had already
 * drifted: this table used to claim `pair.create` returned only a code, role
 * and expiry, while the hub has long returned the pairing link and QR too -
 * which both the CLI and the dashboard were reading through their own,
 * separately-written annotations.
 *
 * Every entry must match what `handleAdmin` actually replies.
 */
export interface AdminData {
  'devices.list': { devices: Device[]; online: string[] };
  'devices.revoke': { revoked: boolean };
  'devices.rename': { device?: Device };
  'devices.setRole': { device?: Device };
  'pair.create': IssuedPairingCode;
  'pair.list': { codes: PairingCode[] };
  'pair.revoke': { revoked: boolean };
  'roles.list': { roles: Role[] };
  'roles.upsert': { roles: Role[] };
  'roles.delete': { deleted: boolean };
  'notify.send': Record<string, never>;
  'notify.resolve': { resolved: string[] };
  'call.place': Record<string, never>;
  'heartbeats.list': { heartbeats: Heartbeat[] };
  'heartbeat.expect': { heartbeat: Heartbeat };
  'heartbeat.checkin': { known: boolean };
  'heartbeat.forget': { forgotten: boolean };
  'policies.list': { policies: EscalationPolicy[] };
  'policies.upsert': { policies: EscalationPolicy[] };
  'policies.delete': { deleted: boolean };
  metrics: { text: string };
  'audit.tail': { events: AuditEvent[] };
  history: { notifications: Notification[] };
}

/**
 * A freshly minted pairing code, as `pair.create` returns it.
 *
 * The hub builds the link and renders the QR because it is the only party that
 * knows its own reachable address; a client cannot reconstruct either.
 */
export interface IssuedPairingCode {
  code: string;
  role: string;
  expiresAt: number;
  /** Deep link carrying both the hub address and the code. */
  link: string;
  /** The same link as a QR code, for scanning with a phone. */
  qr: { svg: string; terminal: string };
}

/** The reply type for an op, or `unknown` for one nothing has described. */
export type AdminResult<Op extends AdminOp> = Op extends keyof AdminData
  ? AdminData[Op]
  : unknown;
