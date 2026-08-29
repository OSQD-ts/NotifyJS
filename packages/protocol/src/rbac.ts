import type { Capability, Role, Severity, Targeting } from './types.js';
import { severityRank } from './types.js';

/**
 * Channel patterns support `*` as a wildcard over any run of characters, and a
 * leading `!` to exclude. Exclusions always win, so `["*", "!debug.*"]` reads
 * the way you would say it out loud: everything except the debug channels.
 */
export function channelMatches(patterns: string[], channel: string): boolean {
  let allowed = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    const body = negated ? pattern.slice(1) : pattern;
    if (!globMatch(body, channel)) continue;
    if (negated) return false;
    allowed = true;
  }
  return allowed;
}

function globMatch(pattern: string, value: string): boolean {
  const rx = new RegExp(
    '^' + pattern.split('*').map(escapeRegExp).join('.*') + '$',
    'i',
  );
  return rx.test(value);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `admin` is a superset; every other capability is checked literally. */
export function hasCapability(role: Role, cap: Capability): boolean {
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
