import { BlockList, isIPv4, isIPv6 } from 'node:net';

import type { SecurityOptions } from './options.js';
import type { Store } from './store.js';

export type Rejection = { ok: false; reason: string; retryAfter: number };
export type Allowance = { ok: true };

interface IpState {
  /** Token bucket over connection attempts. */
  tokens: number;
  lastRefill: number;
  concurrent: number;
}

/**
 * Everything standing between an open port and a brute-forced pairing code.
 *
 * The layers are deliberately independent: an attacker who works around one
 * (say, by pacing requests under the connection rate limit) still runs into
 * the failure counter, and one who spreads failures across many IPs still
 * faces per-code entropy and short expiry.
 */
export class Guard {
  private ips = new Map<string, IpState>();
  private unauthenticated = 0;
  private sweeper: NodeJS.Timeout | undefined;
  /**
   * Built once rather than scanned per connection. These lists are an
   * operator's allow/deny rules and can run to thousands of entries; walking
   * them on every TCP upgrade puts an attacker's own connection rate in charge
   * of how much work the hub does before it has rejected them.
   */
  private readonly denyIps: BlockList | undefined;
  private readonly allowIps: BlockList | undefined;

  constructor(
    private readonly sec: SecurityOptions,
    private readonly store: Store,
  ) {
    this.denyIps = compileIpList('denyIps', sec.denyIps);
    this.allowIps = compileIpList('allowIps', sec.allowIps);
    this.start();
  }

  /**
   * Arms the sweeper. Idempotent, and safe to call again after `stop()`.
   *
   * Separate from the constructor because a hub can be stopped and started
   * again: armed only at construction, the sweeper stayed dead after the first
   * restart, and a scan across a /16 would leave 65k IpState entries resident
   * forever - the slow memory leak this exists to prevent.
   */
  start(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  /**
   * The operator's allow/deny rules alone, with no slot taken.
   *
   * Separate from `admit()` because a request that never opens a session - an
   * HTTP publish - has nothing to release a connection slot with, yet "only
   * these IPs may connect at all" has to mean it for that path too.
   */
  refused(ip: string): boolean {
    if (this.denyIps && matchesIp(this.denyIps, ip)) return true;
    // An address that cannot be parsed matches nothing, so an allow list
    // refuses it - which is the safe direction for a list that says "only
    // these".
    return this.allowIps !== undefined && !matchesIp(this.allowIps, ip);
  }

  /** Called on TCP upgrade, before a WebSocket session exists. */
  admit(ip: string): Allowance | Rejection {
    if (this.refused(ip)) {
      return { ok: false, reason: 'denied', retryAfter: 3600 };
    }

    const ban = this.store.ban(ip);
    if (ban && ban.until > Date.now()) {
      return {
        ok: false,
        reason: 'banned',
        retryAfter: Math.ceil((ban.until - Date.now()) / 1000),
      };
    }

    if (this.unauthenticated >= this.sec.maxUnauthenticated) {
      // Hub-wide backstop: a flood of half-open handshakes must not be able to
      // exhaust memory or crowd out legitimate devices reconnecting.
      return { ok: false, reason: 'busy', retryAfter: 30 };
    }

    const state = this.state(ip);
    if (state.concurrent >= this.sec.maxConnectionsPerIp) {
      return { ok: false, reason: 'too_many_connections', retryAfter: 30 };
    }
    if (state.tokens < 1) {
      const wait = (1 - state.tokens) / this.sec.connectionRefillPerSec;
      return { ok: false, reason: 'rate_limited', retryAfter: Math.ceil(wait) };
    }

    state.tokens -= 1;
    state.concurrent += 1;
    this.unauthenticated += 1;
    return { ok: true };
  }

  /** A session that reached `ready` no longer counts against the unauth cap. */
  promote(): void {
    this.unauthenticated = Math.max(0, this.unauthenticated - 1);
  }

  /**
   * Releases a session's slot.
   *
   * `wasAuthenticated` must mean "this session was counted by `promote()`",
   * not "this session looks ready right now". A hub-initiated close marks the
   * session closed before the socket's close event arrives, so reading the
   * state here would decrement the unauthenticated counter a second time and
   * let the hub-wide handshake cap drift open under normal operation.
   */
  release(ip: string, wasAuthenticated: boolean): void {
    const state = this.ips.get(ip);
    if (state) state.concurrent = Math.max(0, state.concurrent - 1);
    if (!wasAuthenticated) {
      this.unauthenticated = Math.max(0, this.unauthenticated - 1);
    }
  }

  /**
   * Records a failed pair or auth attempt, banning the IP once failures pass
   * the threshold. Ban length doubles per offence, so a persistent attacker
   * is measured in hours of silence while a user who fat-fingered a code once
   * waits a minute.
   */
  fail(ip: string): { banned: boolean; until: number } {
    const now = Date.now();
    const prior = this.store.ban(ip);
    const withinWindow = prior && now - prior.lastFailureAt < this.sec.failureWindowMs;

    const failures = (withinWindow ? prior.failures : 0) + 1;
    const level = prior?.level ?? 0;

    if (failures >= this.sec.maxFailuresBeforeBan) {
      const nextLevel = level + 1;
      const duration = Math.min(
        this.sec.banBaseMs * 2 ** (nextLevel - 1),
        this.sec.banMaxMs,
      );
      const until = now + duration;
      this.store.putBan({ ip, until, level: nextLevel, lastFailureAt: now, failures: 0 });
      return { banned: true, until };
    }

    this.store.putBan({
      ip,
      until: prior?.until ?? 0,
      level,
      lastFailureAt: now,
      failures,
    });
    return { banned: false, until: 0 };
  }

  /**
   * A success clears the failure counter but deliberately preserves `level`,
   * so an attacker cannot reset their backoff by interleaving one valid
   * handshake from a device they already own.
   */
  succeed(ip: string): void {
    const prior = this.store.ban(ip);
    if (!prior) return;

    // A ban that is still running stays running. Preserving `level` only makes
    // the next ban longer; clearing `until` handed the lockout itself back for
    // the price of one valid handshake, which an attacker has whenever they
    // hold any paired device or any ingest token - or whenever they share a
    // NAT with somebody who does. `admit()` refuses new connections from a
    // banned address but says nothing about the sockets already open, so this
    // was reachable from a session opened before the ban landed: five guesses,
    // one honest auth, five more guesses, indefinitely.
    if (prior.until > Date.now()) {
      this.store.putBan({ ...prior, failures: 0 });
      return;
    }

    if (prior.level === 0) {
      this.store.clearBan(ip);
      return;
    }
    this.store.putBan({ ...prior, failures: 0, until: 0 });
  }

  bannedFor(ip: string): number {
    const ban = this.store.ban(ip);
    if (!ban || ban.until <= Date.now()) return 0;
    return ban.until - Date.now();
  }

  private state(ip: string): IpState {
    const now = Date.now();
    let state = this.ips.get(ip);
    if (!state) {
      state = { tokens: this.sec.connectionBurst, lastRefill: now, concurrent: 0 };
      this.ips.set(ip, state);
    }
    const elapsed = (now - state.lastRefill) / 1000;
    if (elapsed > 0) {
      state.tokens = Math.min(
        this.sec.connectionBurst,
        state.tokens + elapsed * this.sec.connectionRefillPerSec,
      );
      state.lastRefill = now;
    }
    return state;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [ip, state] of this.ips) {
      const idle = now - state.lastRefill > 10 * 60_000;
      if (idle && state.concurrent === 0 && state.tokens >= this.sec.connectionBurst) {
        this.ips.delete(ip);
      }
    }
    for (const ban of this.store.bans()) {
      // Expired bans are kept only while their backoff level still matters.
      const stale = now - ban.lastFailureAt > this.sec.failureWindowMs * 8;
      if (ban.until < now && stale) this.store.clearBan(ban.ip);
    }
  }
}

/**
 * A rejected handshake should take the same wall-clock time whether the code
 * did not exist, had expired, or had a bad signature. Otherwise the response
 * latency itself tells an attacker when they have found a live code.
 */
export async function uniformDelay(startedAt: number, floorMs: number): Promise<void> {
  const elapsed = Date.now() - startedAt;
  // Jitter keeps the floor from becoming its own recognisable signature.
  const target = floorMs + Math.random() * (floorMs / 2);
  if (elapsed < target) {
    await new Promise((r) => setTimeout(r, target - elapsed));
  }
}

/** Per-connection flood control once a socket is authenticated. */
export class MessageLimiter {
  private count = 0;
  private windowStart = Date.now();

  constructor(private readonly points: number, private readonly windowMs: number) {}

  allow(): boolean {
    const now = Date.now();
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.count = 0;
    }
    this.count += 1;
    return this.count <= this.points;
  }
}

/**
 * Compiles an operator's allow or deny list, accepting CIDR ranges.
 *
 * Both lists used to be sets of exact strings, and nothing said so.
 * `allowIps: ['10.0.0.0/24']` - the obvious way to write "only my LAN" - then
 * matched no real address at all: the hub looked locked to a subnet and was
 * locked to nobody, refusing every device it had. The same entry under
 * `denyIps` refused nobody, which is the same failure pointing the other way.
 *
 * An entry that is neither an address nor a range is refused by name here, at
 * construction, while the operator who wrote it is still reading output -
 * rather than at the first connection, where the symptom is silence.
 *
 * `BlockList` keeps the matching native, so the lists can stay long without an
 * attacker's connection rate deciding how much work the hub does per attempt.
 */
export function compileIpList(
  option: 'allowIps' | 'denyIps' | 'pairing code allowIps',
  entries: readonly string[] | undefined,
): BlockList | undefined {
  // Absent and empty are different answers, and only absent means "no rule".
  // An allow list that is present and empty says nothing may connect, which is
  // what an operator building one from configuration gets when the source is
  // empty - `(process.env.ALLOW_IPS ?? '').split(',').filter(Boolean)`. Treating
  // that as "no rule" would turn a hub that refuses everybody, loudly, into one
  // that has an allow list and enforces nothing.
  if (!entries) return undefined;

  const list = new BlockList();
  for (const raw of entries) {
    const entry = raw.trim();
    const slash = entry.indexOf('/');
    const address = slash === -1 ? entry : entry.slice(0, slash);
    const family = isIPv4(address) ? 'ipv4' : isIPv6(address) ? 'ipv6' : undefined;
    const bad = new Error(
      `${option === 'pairing code allowIps' ? option : `security.${option}`}: "${raw}" is not an IP address or CIDR range (try "10.0.0.5" or "10.0.0.0/24")`,
    );
    if (!family) throw bad;

    try {
      if (slash === -1) {
        list.addAddress(address, family);
      } else {
        const prefix = entry.slice(slash + 1);
        // Checked rather than passed to `Number`: `"10.0.0.0/"` would become a
        // prefix of 0, which matches every address on the internet.
        if (!/^\d{1,3}$/.test(prefix)) throw bad;
        list.addSubnet(address, Number(prefix), family);
      }
    } catch {
      throw bad;
    }
  }
  return list;
}

/** Whether an address matches a compiled list. */
export function matchesIp(list: BlockList, ip: string): boolean {
  const family = isIPv4(ip) ? 'ipv4' : isIPv6(ip) ? 'ipv6' : undefined;
  return family !== undefined && list.check(ip, family);
}

/** IPv4-mapped IPv6 (`::ffff:1.2.3.4`) must not read as a distinct IP. */
export function normalizeIp(raw: string | undefined): string {
  if (!raw) return 'unknown';
  const ip = raw.trim();
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
