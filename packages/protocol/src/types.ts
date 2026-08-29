/**
 * Core domain model. These types are shared verbatim by the hub, the web
 * dashboard, the phone app and the CLI, so every peer agrees on what a
 * notification *is* without a translation layer in between.
 */

/** Ordered from least to most urgent. Roles subscribe at a minimum level. */
export const SEVERITIES = ['debug', 'info', 'success', 'warning', 'error', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Numeric rank used for `minSeverity` comparisons. */
export function severityRank(s: Severity): number {
  const i = SEVERITIES.indexOf(s);
  return i < 0 ? 0 : i;
}

/**
 * What a device is allowed to do once authenticated. `admin` implies all
 * others; everything else is granted explicitly.
 */
export const CAPABILITIES = [
  'notify.receive',
  'notify.ack',
  'notify.send',
  'call.receive',
  'call.place',
  'devices.manage',
  'roles.manage',
  'audit.read',
  'admin',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * A named permission bundle. Pairing codes carry a role, and the device
 * inherits it; changing the role changes what already-paired devices see on
 * their next delivery.
 */
export interface Role {
  name: string;
  description?: string;
  /** Channel glob patterns, e.g. `["db.*", "deploy"]`. `["*"]` matches all. */
  channels: string[];
  /** Notifications below this severity are never delivered to the role. */
  minSeverity: Severity;
  capabilities: Capability[];
  /** Refuse to pair more than this many devices into the role. */
  maxDevices?: number;
  /**
   * Calls (not notifications) are suppressed during these local hours.
   * `{ start: 22, end: 7 }` means 22:00–07:00. Severity `critical` overrides.
   */
  quietHours?: { start: number; end: number };
}

export type DeviceStatus = 'active' | 'revoked';

export interface Device {
  id: string;
  name: string;
  role: string;
  /** Raw Ed25519 public key, base64url. The hub never stores a private key. */
  publicKey: string;
  platform: string;
  model?: string;
  status: DeviceStatus;
  createdAt: number;
  lastSeenAt?: number;
  lastIp?: string;
  /** Delivery cursor: the last event sequence this device acknowledged. */
  ackedSeq: number;
  /**
   * Wake-up token for when the device is not connected. Opt-in, and only set
   * by the device itself - see `PushOptions` for what enabling it implies.
   */
  pushToken?: string;
  pushProvider?: 'expo';
  /**
   * Silenced until this timestamp. Set by the device itself; `critical` still
   * gets through, so snoozing quiets noise without disabling the pager.
   */
  snoozedUntil?: number;
}

export interface NotificationAction {
  id: string;
  label: string;
  /** `primary` renders as the highlighted button on every client. */
  style?: 'primary' | 'danger' | 'default';
}

export interface Notification {
  id: string;
  /** Monotonic per-hub sequence. Clients resync with `sync{ since }`. */
  seq: number;
  ts: number;
  channel: string;
  severity: Severity;
  title: string;
  body?: string;
  tags?: string[];
  /** Arbitrary structured payload passed through untouched to clients. */
  data?: Record<string, unknown>;
  actions?: NotificationAction[];
  /** Keep re-delivering until some device acknowledges it. */
  requireAck?: boolean;
  /** Milliseconds after `ts` past which the notification is dropped undelivered. */
  ttl?: number;
  /** Restrict delivery beyond what the role filter already allows. */
  to?: Targeting;
  /**
   * Groups an alert with its later resolution. Resolving the key clears every
   * notification that carried it, so screens do not fill with alerts that
   * stopped being true hours ago.
   */
  resolveKey?: string;
  /** Set once the condition has cleared. */
  resolvedAt?: number;
}

/** Narrows delivery to specific roles or devices, on top of RBAC filtering. */
export interface Targeting {
  roles?: string[];
  devices?: string[];
}

/** One rung of an escalation ladder. */
export interface EscalationStep {
  /** Who to ring. Omitted means everyone the call's role filter allows. */
  to?: Targeting;
  /** How long this rung rings before the next one starts. */
  ringSeconds?: number;
  /** Pause before this rung begins. */
  delaySeconds?: number;
}

/**
 * An ordered plan for reaching a human.
 *
 * "Ring whoever was seen most recently" is a heuristic, not a policy. This is
 * the difference between a notification toy and something you would trust to
 * wake the right person at 3am.
 */
export interface EscalationPolicy {
  name: string;
  description?: string;
  steps: EscalationStep[];
  /** Run the whole ladder again this many extra times before giving up. */
  repeat?: number;
}

export interface CallRequest {
  id: string;
  seq: number;
  ts: number;
  channel: string;
  severity: Severity;
  /** Shown on the incoming-call screen in place of a caller name. */
  from: string;
  /** Spoken aloud by the device's text-to-speech engine on answer. */
  message: string;
  /** BCP-47 language tag for TTS, e.g. `en-US`, `pl-PL`. */
  lang?: string;
  /** TTS rate/pitch, 1 is the platform default. */
  rate?: number;
  pitch?: number;
  /** How long a device rings before it counts as unanswered. */
  ringSeconds?: number;
  /** Repeat the spoken message this many times after answering. */
  repeat?: number;
  to?: Targeting;
  /** Escalate to the next matching device when nobody answers. */
  escalate?: boolean;
  /** Name of an escalation policy, which overrides `escalate`. */
  policy?: string;
}

export type CallOutcome = 'answered' | 'declined' | 'missed' | 'cancelled' | 'failed';

export interface CallResult {
  callId: string;
  outcome: CallOutcome;
  deviceId?: string;
  deviceName?: string;
  answeredAt?: number;
  endedAt?: number;
  /** Devices that were rung before this outcome was reached. */
  attempted: string[];
}

export interface PairingCode {
  /** SHA-256 of the normalised code. The plaintext code is never stored. */
  hash: string;
  role: string;
  createdAt: number;
  expiresAt: number;
  /** Times the code may still be redeemed. */
  usesLeft: number;
  /** Optional CIDR-less IP allowlist for redemption. */
  allowIps?: string[];
  label?: string;
}

export interface AuditEvent {
  ts: number;
  kind: string;
  ip?: string;
  deviceId?: string;
  detail?: Record<string, unknown>;
}
