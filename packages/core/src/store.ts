import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Heartbeat } from './watchdog.js';
import type { EscalationPolicy } from '@osqd/notifyjs-protocol';
import {
  defaultRoles,
  pairingCodeHash,
  type AuditEvent,
  type Device,
  type Notification,
  type PairingCode,
  type Role,
} from '@osqd/notifyjs-protocol';

/** Reads the last `limit` JSON lines, skipping any the process died mid-write. */
function readTail<T>(file: string, limit: number): T[] {
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const out: T[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // A torn final line is expected after a crash; the rest is still good.
      }
    }
    // Trim after parsing, so a damaged line does not cost a retention slot.
    return out.slice(-limit);
  } catch {
    return [];
  }
}

/**
 * Own-property lookup for the store's string-keyed maps.
 *
 * These are plain JSON objects indexed by names that arrive over the wire, so
 * a plain `map[key]` answers `"constructor"` and `"__proto__"` with something
 * inherited from `Object.prototype` - a truthy value that is not a record.
 */
function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** Keys that would mutate a plain object's prototype rather than its contents. */
function unsafeKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

function countLines(file: string): number {
  if (!existsSync(file)) return 0;
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** Ceiling on retained ban records. See `Store.putBan`. */
const MAX_BANS = 10_000;

export interface BanRecord {
  ip: string;
  until: number;
  /** Number of bans served. Drives the exponential backoff. */
  level: number;
  lastFailureAt: number;
  failures: number;
}

interface StoreData {
  version: 1;
  serverId: string;
  seq: number;
  devices: Record<string, Device>;
  roles: Record<string, Role>;
  codes: Record<string, PairingCode>;
  bans: Record<string, BanRecord>;
  heartbeats: Record<string, Heartbeat>;
  policies: Record<string, EscalationPolicy>;
  /** Legacy inline collections, migrated to their own files on first load. */
  history?: Notification[];
  audit?: AuditEvent[];
}

/**
 * A single JSON file, written atomically. Self-hosting should not require
 * standing up a database, and the working set here — a handful of devices and
 * a bounded notification history — fits comfortably in memory.
 */
export class Store {
  private data: StoreData;
  private readonly file: string;
  private readonly historyFile: string;
  private readonly auditFile: string;
  private saveTimer: NodeJS.Timeout | undefined;
  private dirty = false;

  /**
   * History and audit are append-only logs, not part of the JSON document.
   *
   * Rewriting the whole store for every notification made the cost of sending
   * one proportional to everything ever sent - a few hundred history entries
   * and a thousand audit rows re-serialised each time. Appending a line keeps
   * it constant, and the in-memory cache serves every read.
   */
  private historyCache: Notification[] = [];
  private auditCache: AuditEvent[] = [];
  private historyPending: string[] = [];
  private auditPending: string[] = [];
  private historyLines = 0;
  private auditLines = 0;

  constructor(
    private readonly dir: string,
    private readonly limits: { history: number; audit: number },
    serverIdFactory: () => string,
  ) {
    // 0700: the store holds device public keys and audit history. Nothing
    // secret enough to be catastrophic, but no reason to let other local
    // accounts enumerate the operator's devices.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, 'store.json');
    this.historyFile = join(dir, 'history.jsonl');
    this.auditFile = join(dir, 'audit.jsonl');

    const existed = existsSync(this.file);
    this.data = this.load(serverIdFactory);

    // A fresh store must be written even if nothing is ever added to it. The
    // serverId is part of every auth signature, so letting it be regenerated
    // on the next boot would invalidate every paired device.
    if (!existed) this.markDirty();

    this.historyCache = readTail<Notification>(this.historyFile, limits.history);
    this.auditCache = readTail<AuditEvent>(this.auditFile, limits.audit);
    this.historyLines = countLines(this.historyFile);
    this.auditLines = countLines(this.auditFile);

    this.migrateInlineCollections();
  }

  /**
   * Older stores kept history and audit inside store.json. Move them across
   * once so an upgrade does not silently lose an operator's history.
   */
  private migrateInlineCollections(): void {
    const { history, audit } = this.data;
    if (!history?.length && !audit?.length) return;

    for (const n of history ?? []) this.pushHistory(n);
    for (const e of audit ?? []) this.audit(e);

    delete this.data.history;
    delete this.data.audit;
    this.markDirty();
    this.flush();
  }

  private load(serverIdFactory: () => string): StoreData {
    const fresh = (): StoreData => ({
      version: 1,
      serverId: serverIdFactory(),
      seq: 0,
      devices: {},
      roles: Object.fromEntries(defaultRoles().map((r) => [r.name, r])),
      codes: {},
      bans: {},
      heartbeats: {},
      policies: {},
    });

    if (!existsSync(this.file)) return fresh();
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as StoreData;
      if (!parsed || typeof parsed !== 'object') throw new Error('not a store document');
      const merged = { ...fresh(), ...parsed };
      // Roles ship with the library and may gain new defaults between
      // versions; merge them in without clobbering operator edits. Guarded
      // because an older or partial document may have no `roles` at all, and
      // losing an operator's devices over a missing key is not a fair trade.
      if (!merged.roles || typeof merged.roles !== 'object') merged.roles = {};
      for (const role of defaultRoles()) merged.roles[role.name] ??= role;
      return merged;
    } catch {
      // A truncated store must not stop the app that embedded us from booting.
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        renameSync(this.file, backup);
      } catch {
        /* best effort */
      }
      return fresh();
    }
  }

  /** Coalesces bursts of writes; a fan-out of 50 notifications is one fsync. */
  private markDirty(): void {
    this.dirty = true;
    this.scheduleDrain();
  }

  /**
   * Arms the shared flush timer without marking the JSON document dirty, so an
   * append does not drag a full store rewrite along with it.
   */
  private scheduleDrain(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.flush();
    }, 50);
    this.saveTimer.unref?.();
  }

  flush(): void {
    this.drain(this.historyFile, this.historyPending, (written) => {
      this.historyLines += written;
    });
    this.drain(this.auditFile, this.auditPending, (written) => {
      this.auditLines += written;
    });

    // Compacting only when the file has grown to twice the retained window
    // keeps rewrites rare while bounding the file to a predictable size.
    if (this.historyLines > this.limits.history * 2) {
      this.compact(this.historyFile, this.historyCache);
      this.historyLines = this.historyCache.length;
    }
    if (this.auditLines > this.limits.audit * 2) {
      this.compact(this.auditFile, this.auditCache);
      this.auditLines = this.auditCache.length;
    }

    if (!this.dirty) return;
    this.dirty = false;
    const tmp = `${this.file}.tmp`;
    // Write-then-rename: a crash mid-write leaves the previous store intact
    // rather than a half-serialised file that would fail to parse on boot.
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Appends buffered lines in one syscall, or drops them if the disk is gone. */
  private drain(file: string, pending: string[], onWritten: (n: number) => void): void {
    if (pending.length === 0) return;
    const lines = pending.splice(0, pending.length);
    try {
      appendFileSync(file, lines.join(''), { mode: 0o600 });
      onWritten(lines.length);
    } catch {
      // Losing a history line must never take down the app that embedded us.
    }
  }

  private compact(file: string, entries: unknown[]): void {
    try {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, entries.map((e) => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });
      renameSync(tmp, file);
    } catch {
      /* best effort */
    }
  }

  close(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.flush();
  }

  get serverId(): string {
    return this.data.serverId;
  }

  nextSeq(): number {
    this.data.seq += 1;
    this.markDirty();
    return this.data.seq;
  }

  get seq(): number {
    return this.data.seq;
  }

  /* ----------------------------- devices ----------------------------- */

  device(id: string): Device | undefined {
    return own(this.data.devices, id);
  }

  devices(): Device[] {
    return Object.values(this.data.devices);
  }

  /** Guards against two devices claiming the same keypair. */
  deviceByPublicKey(publicKey: string): Device | undefined {
    return Object.values(this.data.devices).find((d) => d.publicKey === publicKey);
  }

  putDevice(d: Device): void {
    if (unsafeKey(d.id)) throw new Error(`"${d.id}" cannot be used as a device id`);
    this.data.devices[d.id] = d;
    this.markDirty();
  }

  updateDevice(id: string, patch: Partial<Device>): Device | undefined {
    // `own`, not `[id]`: a device id arrives over the wire, and
    // `devices['constructor']` answers with something inherited from
    // Object.prototype - truthy, not a device, and spreading it would write a
    // fabricated entry into the store under a key nothing can ever reach.
    const existing = own(this.data.devices, id);
    if (!existing || unsafeKey(id)) return undefined;
    const next = { ...existing, ...patch };
    this.data.devices[id] = next;
    this.markDirty();
    return next;
  }

  deleteDevice(id: string): boolean {
    if (!own(this.data.devices, id)) return false;
    delete this.data.devices[id];
    this.markDirty();
    return true;
  }

  /* ------------------------------ roles ------------------------------ */

  role(name: string): Role | undefined {
    return own(this.data.roles, name);
  }

  roles(): Role[] {
    return Object.values(this.data.roles);
  }

  putRole(r: Role): void {
    if (unsafeKey(r.name)) throw new Error(`"${r.name}" cannot be used as a role name`);
    this.data.roles[r.name] = r;
    this.markDirty();
  }

  deleteRole(name: string): boolean {
    if (!own(this.data.roles, name)) return false;
    delete this.data.roles[name];
    this.markDirty();
    return true;
  }

  /* -------------------------- pairing codes -------------------------- */

  /** Codes are keyed by hash, so the plaintext is never at rest anywhere. */
  putCode(code: PairingCode): void {
    // Minting is the natural moment to clear out codes that are spent or past
    // their expiry, so they do not accumulate in the store between listings.
    this.pruneCodes();
    this.data.codes[code.hash] = code;
    this.markDirty();
  }

  /**
   * Claims one use of a code, atomically with respect to the event loop.
   *
   * Redemption spans an `await` (verifying the device's signature), so the
   * decrement has to happen before that gap rather than after it - otherwise
   * two sockets presenting the same single-use code both see `usesLeft: 1`
   * and both pair. The record is returned by value so a caller cannot undo
   * the decrement by mutating it.
   */
  reserveCode(normalized: string): PairingCode | undefined {
    const hash = pairingCodeHash(normalized);
    const found = own(this.data.codes, hash);
    if (!found) return undefined;
    if (found.expiresAt < Date.now() || found.usesLeft <= 0) {
      delete this.data.codes[hash];
      this.markDirty();
      return undefined;
    }

    const claimed = { ...found };
    // Decremented in place rather than deleted, so a rejection further along
    // has something to give the use back to. A code at zero is already
    // unreachable - the check above refuses it - and `pruneCodes` clears it.
    found.usesLeft -= 1;
    this.markDirty();
    return claimed;
  }

  /** Hands a reserved use back after the redemption failed for other reasons. */
  releaseCode(hash: string): void {
    const existing = own(this.data.codes, hash);
    if (!existing) return;
    existing.usesLeft += 1;
    this.markDirty();
  }

  codes(): PairingCode[] {
    this.pruneCodes();
    return Object.values(this.data.codes);
  }

  revokeCode(hash: string): boolean {
    if (!own(this.data.codes, hash)) return false;
    delete this.data.codes[hash];
    this.markDirty();
    return true;
  }

  pruneCodes(): void {
    const now = Date.now();
    let changed = false;
    for (const [hash, code] of Object.entries(this.data.codes)) {
      if (code.expiresAt < now || code.usesLeft <= 0) {
        delete this.data.codes[hash];
        changed = true;
      }
    }
    if (changed) this.markDirty();
  }

  /* ------------------------------- bans ------------------------------ */

  ban(ip: string): BanRecord | undefined {
    return own(this.data.bans, ip);
  }

  putBan(record: BanRecord): void {
    if (unsafeKey(record.ip)) return;
    // Behind a proxy the client IP comes from a header, so the number of
    // distinct "IPs" is whatever an attacker cares to send. Evicting the
    // stalest records keeps a store file from growing without limit.
    if (!own(this.data.bans, record.ip) && Object.keys(this.data.bans).length >= MAX_BANS) {
      const oldest = Object.values(this.data.bans)
        .filter((b) => b.until < Date.now())
        .sort((a, b) => a.lastFailureAt - b.lastFailureAt)[0];
      if (oldest) delete this.data.bans[oldest.ip];
      else return; // Every slot is an active ban; keeping those matters more.
    }
    this.data.bans[record.ip] = record;
    this.markDirty();
  }

  clearBan(ip: string): void {
    if (own(this.data.bans, ip)) {
      delete this.data.bans[ip];
      this.markDirty();
    }
  }

  bans(): BanRecord[] {
    return Object.values(this.data.bans);
  }

  /* --------------------------- policies ------------------------------ */

  policy(name: string): EscalationPolicy | undefined {
    return this.data.policies ? own(this.data.policies, name) : undefined;
  }

  policies(): EscalationPolicy[] {
    return Object.values(this.data.policies ?? {});
  }

  putPolicy(policy: EscalationPolicy): void {
    if (unsafeKey(policy.name)) throw new Error(`"${policy.name}" cannot be used as a policy name`);
    this.data.policies ??= {};
    this.data.policies[policy.name] = policy;
    this.markDirty();
  }

  deletePolicy(name: string): boolean {
    if (!this.data.policies || !own(this.data.policies, name)) return false;
    delete this.data.policies[name];
    this.markDirty();
    return true;
  }

  /* --------------------------- heartbeats ---------------------------- */

  heartbeats(): Heartbeat[] {
    return Object.values(this.data.heartbeats ?? {});
  }

  putHeartbeat(beat: Heartbeat): void {
    if (unsafeKey(beat.name)) throw new Error(`"${beat.name}" cannot be used as a heartbeat name`);
    this.data.heartbeats ??= {};
    this.data.heartbeats[beat.name] = beat;
    this.markDirty();
  }

  deleteHeartbeat(name: string): boolean {
    if (!this.data.heartbeats || !own(this.data.heartbeats, name)) return false;
    delete this.data.heartbeats[name];
    this.markDirty();
    return true;
  }

  /* ----------------------------- history ----------------------------- */

  pushHistory(n: Notification): void {
    this.historyCache.push(n);
    if (this.historyCache.length > this.limits.history) {
      this.historyCache.splice(0, this.historyCache.length - this.limits.history);
    }
    this.historyPending.push(JSON.stringify(n) + '\n');
    this.scheduleDrain();
  }

  /**
   * A copy: the cache is the hub's replay buffer, and a caller that spliced
   * or reordered it would silently change what every reconnecting device is
   * told it missed. The notifications themselves are shared by reference so
   * `resolve()` can still mark them, which `touchHistory()` then persists.
   */
  history(): Notification[] {
    return [...this.historyCache];
  }

  /**
   * Persists in-place edits to cached history (a notification being resolved).
   *
   * The log is append-only, so the cheapest correct fix is to rewrite it from
   * the cache - which is bounded by the retention limit.
   */
  touchHistory(): void {
    // The cache already contains everything still queued for append. Writing
    // it out and then draining the queue would append those lines a second
    // time, so the queue is dropped rather than flushed.
    this.historyPending.length = 0;
    this.compact(this.historyFile, this.historyCache);
    this.historyLines = this.historyCache.length;
  }

  since(seq: number): Notification[] {
    return this.historyCache.filter((n) => n.seq > seq);
  }

  /* ------------------------------ audit ------------------------------ */

  audit(e: AuditEvent): void {
    this.auditCache.push(e);
    if (this.auditCache.length > this.limits.audit) {
      this.auditCache.splice(0, this.auditCache.length - this.limits.audit);
    }
    this.auditPending.push(JSON.stringify(e) + '\n');
    this.scheduleDrain();
  }

  auditTail(n: number): AuditEvent[] {
    return this.auditCache.slice(-n);
  }
}
