import type { Capability, Role, Severity, Targeting } from './types.js';
import { CAPABILITIES, SEVERITIES, severityRank } from './types.js';

/**
 * Channel patterns support `*` as a wildcard over any run of characters, and a
 * leading `!` to exclude. Exclusions always win, so `["*", "!debug.*"]` reads
 * the way you would say it out loud: everything except the debug channels.
 */
export function channelMatches(patterns: string[], channel: string): boolean {
  // A role can be edited over the wire, so a malformed `channels` must read as
  // "matches nothing" rather than throw inside the delivery loop.
  if (!Array.isArray(patterns)) return false;

  let allowed = false;
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue;
    const negated = pattern.startsWith('!');
    const body = negated ? pattern.slice(1) : pattern;
    if (!globMatch(body, channel)) continue;
    if (negated) return false;
    allowed = true;
  }
  return allowed;
}

/**
 * Matches `*` against any run of characters, iteratively.
 *
 * Deliberately not a compiled regular expression: `a*a*a*a*b` translates to
 * `.*.*.*.*` and backtracks exponentially, so a role with a handful of
 * wildcards would let a single notification pin the event loop. This walks
 * each string once, remembering the last `*` to fall back to.
 */
function globMatch(pattern: string, value: string): boolean {
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();

  let pi = 0;
  let vi = 0;
  let star = -1;
  let mark = 0;

  while (vi < v.length) {
    if (pi < p.length && (p[pi] === v[vi] || p[pi] === '*')) {
      if (p[pi] === '*') {
        star = pi++;
        mark = vi;
      } else {
        pi++;
        vi++;
      }
    } else if (star >= 0) {
      // Backtrack to the most recent `*` and let it swallow one more character.
      pi = star + 1;
      vi = ++mark;
    } else {
      return false;
    }
  }
  while (p[pi] === '*') pi++;
  return pi === p.length;
}

/** `admin` is a superset; every other capability is checked literally. */
export function hasCapability(role: Role, cap: Capability): boolean {
  if (!role || !Array.isArray(role.capabilities)) return false;
  return role.capabilities.includes('admin') || role.capabilities.includes(cap);
}

export interface DeliveryCheck {
  role: Role;
  deviceId: string;
  channel: string;
  severity: Severity;
  to?: Targeting;
  /** Set for call requests, which are additionally gated by quiet hours. */
  isCall?: boolean;
  now?: Date;
}

/**
 * The single place that decides whether a given device sees a given event.
 * Both the hub and the dashboard's "who would this reach?" preview call this,
 * so the preview can never drift from the real delivery path.
 */
export function canDeliver(c: DeliveryCheck): boolean {
  const needed: Capability = c.isCall ? 'call.receive' : 'notify.receive';
  if (!hasCapability(c.role, needed)) return false;
  if (severityRank(c.severity) < severityRank(c.role.minSeverity)) return false;
  if (!channelMatches(c.role.channels, c.channel)) return false;

  if (c.to?.devices?.length && !c.to.devices.includes(c.deviceId)) return false;
  if (c.to?.roles?.length && !c.to.roles.includes(c.role.name)) return false;

  // A critical call is exactly the thing quiet hours should not silence.
  if (c.isCall && c.role.quietHours && c.severity !== 'critical') {
    if (inQuietHours(c.role.quietHours, c.now ?? new Date())) return false;
  }
  return true;
}

export function inQuietHours(q: { start: number; end: number }, now: Date): boolean {
  const h = now.getHours() + now.getMinutes() / 60;
  // A window like 22->7 wraps past midnight, so the test flips to an OR.
  return q.start <= q.end ? h >= q.start && h < q.end : h >= q.start || h < q.end;
}

/**
 * Capabilities that confer authority over the hub, rather than a place in its
 * fan-out. These are the ones a device may hand out only if it already holds
 * them - otherwise least privilege is decorative, because each of them
 * composes back into `admin` in a move or two: `devices.manage` mints pairing
 * codes, `roles.manage` writes the role those codes point at.
 *
 * The rest (`notify.receive`, `notify.ack`, `call.receive`) only decide
 * whether a device is on the receiving end of something. Which alerts it then
 * sees is a question of channel patterns and severity, which is the operator's
 * to answer when they write the role - so requiring the granter to hold them
 * too would stop a device-manager from issuing an ordinary viewer code
 * without buying anybody any safety.
 */
export const PRIVILEGED_CAPABILITIES = [
  'notify.send',
  'call.place',
  'devices.manage',
  'roles.manage',
  'audit.read',
  'admin',
] as const satisfies readonly Capability[];

export function isPrivileged(cap: Capability): boolean {
  return (PRIVILEGED_CAPABILITIES as readonly string[]).includes(cap);
}

/**
 * The privileged capabilities in `wanted` that `actor` does not itself hold.
 *
 * Empty means the grant is safe. `admin` is the defined superset, so a holder
 * of it is never blocked.
 */
export function escalatingCapabilities(
  actor: Role,
  wanted: readonly Capability[] | undefined,
): Capability[] {
  if (hasCapability(actor, 'admin')) return [];
  return (wanted ?? []).filter((cap) => isPrivileged(cap) && !hasCapability(actor, cap));
}

/**
 * Whether a caller holding `granting` may hand out capability `cap`.
 *
 * `true`/`false` are the historical shorthand for "admin is allowed" and
 * "everything but admin is allowed"; passing the caller's own capability list
 * is the real form - see `sanitizeRole`.
 */
function mayGrant(granting: boolean | readonly Capability[], cap: Capability): boolean {
  if (typeof granting === 'boolean') return granting || cap !== 'admin';
  if (granting.includes('admin')) return true;
  return !isPrivileged(cap) || granting.includes(cap);
}

/**
 * Normalises a role that arrived over the wire.
 *
 * `roles.upsert` is reachable from any device holding `roles.manage`, and the
 * result is consulted on every single delivery. An unvalidated role is
 * therefore both a crash (a non-array `channels` throws inside the fan-out
 * loop, taking every later notification with it) and a privilege escalation.
 *
 * `granting` is what the caller may hand out, and should be the caller's own
 * capability list: a role may never mint a *privileged* capability its author
 * does not itself hold. Blocking only `admin` was not enough, because the
 * capabilities below it compose back into admin - a role carrying
 * `devices.manage` can mint an admin pairing code, and one carrying
 * `roles.manage` can write that role in the first place. Unknown capabilities
 * are dropped rather than rejected, so an older hub tolerates a newer
 * dashboard.
 */
export function sanitizeRole(input: unknown, granting: boolean | readonly Capability[]): Role {
  const raw = (input ?? {}) as Partial<Role>;

  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 64) : '';
  if (!name) throw new Error('a role needs a name');
  // `__proto__` as a key would mutate the prototype of the role map rather
  // than adding an entry to it.
  if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
    throw new Error(`"${name}" cannot be used as a role name`);
  }

  const channels = Array.isArray(raw.channels)
    ? raw.channels.filter((c): c is string => typeof c === 'string').slice(0, 100)
    : [];
  if (channels.length === 0) throw new Error('a role needs at least one channel pattern');

  const capabilities = Array.isArray(raw.capabilities)
    ? raw.capabilities.filter(
        (c): c is Capability =>
          (CAPABILITIES as readonly string[]).includes(c as string) &&
          mayGrant(granting, c as Capability),
      )
    : [];

  const minSeverity =
    typeof raw.minSeverity === 'string' && (SEVERITIES as readonly string[]).includes(raw.minSeverity)
      ? raw.minSeverity
      : 'info';

  const role: Role = {
    name,
    channels,
    minSeverity,
    capabilities: [...new Set(capabilities)],
  };

  if (typeof raw.description === 'string') role.description = raw.description.slice(0, 200);
  if (typeof raw.maxDevices === 'number' && Number.isFinite(raw.maxDevices)) {
    role.maxDevices = Math.max(0, Math.floor(raw.maxDevices));
  }

  const q = raw.quietHours;
  if (q && typeof q.start === 'number' && typeof q.end === 'number') {
    const hour = (h: number) => Math.min(24, Math.max(0, Number.isFinite(h) ? h : 0));
    role.quietHours = { start: hour(q.start), end: hour(q.end) };
  }

  return role;
}

/** Roles shipped out of the box; `roles.upsert` can override any of them. */
export function defaultRoles(): Role[] {
  return [
    {
      name: 'admin',
      description: 'Full control: manage devices, roles, and send notifications.',
      channels: ['*'],
      minSeverity: 'debug',
      capabilities: ['admin'],
    },
    {
      name: 'oncall',
      description: 'Receives warnings and above, and can be called.',
      channels: ['*'],
      minSeverity: 'warning',
      capabilities: ['notify.receive', 'notify.ack', 'call.receive'],
    },
    {
      name: 'viewer',
      description: 'Read-only notification feed. Never rings.',
      channels: ['*', '!debug.*'],
      minSeverity: 'info',
      capabilities: ['notify.receive', 'notify.ack'],
    },
  ];
}
