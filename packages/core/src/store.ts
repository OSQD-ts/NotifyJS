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
import type { IngestToken } from './ingest.js';
import {
  defaultRoles,
  pairingCodeHash,
  type AuditEvent,
  type Device,
  type Notification,
  type PairingCode,
  type Role,
} from '@osqd/notifyjs-protocol';

/**
 * Reads the last `limit` JSON lines, skipping any the process died mid-write,
 * and reports how many lines the file holds.
 *
 * The count comes back from the same pass rather than from a second read: the
 * line total drives compaction, and reading a file that may hold twice the
 * retention window twice over - once to parse, once to count - doubled the
 * startup cost of every hub for a number already in hand.
 */
function readTail<T>(file: string, limit: number): { entries: T[]; lines: number } {
  if (!existsSync(file)) return { entries: [], lines: 0 };
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
    return { entries: out.slice(-limit), lines: lines.length };
  } catch {
    return { entries: [], lines: 0 };
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

/** Ceiling on retained ban records. See `Store.putBan`. */
const MAX_BANS = 10_000;

/** The string-keyed maps in a store document, all restored the same way. */
const COLLECTIONS = [
  'devices',
  'roles',
  'codes',
  'bans',
  'heartbeats',
  'policies',
  'ingestTokens',
] as const;

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
  /**
   * HTTP publishing credentials. Absent from stores written before ingest
   * existed, which `COLLECTIONS` restores to an empty object on load.
   */
  ingestTokens: Record<string, IngestToken>;
  /**
   * The hub's VAPID keypair, generated on first use.
   *
   * Kept rather than derived, because a browser stores the application server
   * key inside the subscription it created: regenerating this invalidates
   * every Web Push subscription at once, silently, and each browser only finds
   * out the next time an alert fails to arrive.
   */
  vapid?: { publicKey: string; privateKey: string };
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
  /** Stops a failed final write from arming a timer nothing will service. */
  private closed = false;

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

  /**
   * Set when the store on disk could not be read and was started over.
   *
   * This is the most destructive thing that can happen here and it used to be
   * completely silent: the `serverId` is part of every auth signature, so a
   * fresh one means every paired device fails to authenticate at once, with no
   * message anywhere connecting the outage to its cause. The path of the file
   * that was set aside, so an operator can be pointed at it.
   */
  readonly recoveredFrom: string | undefined;

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
    const loaded = this.load(serverIdFactory);
    this.data = loaded.data;
    this.recoveredFrom = loaded.recoveredFrom;

    // A fresh store must be written even if nothing is ever added to it. The
    // serverId is part of every auth signature, so letting it be regenerated
    // on the next boot would invalidate every paired device.
    //
    // `recoveredFrom` counts as fresh, and used not to: the file existed, so
    // nothing was marked dirty, so the brand-new document `load()` returned -
    // including its new serverId - was never written. A hub that booted with a
    // corrupt store therefore invented a *third* identity on the restart its own
    // log line invites, invalidating the devices that had just re-paired, and
    // for the whole of that first run `exportStore` found no file to salvage.
    if (!existed || loaded.recoveredFrom) this.markDirty();

    const history = readTail<Notification>(this.historyFile, limits.history);
    const audit = readTail<AuditEvent>(this.auditFile, limits.audit);
    this.historyCache = history.entries;
    this.historyLines = history.lines;
    this.auditCache = audit.entries;
    this.auditLines = audit.lines;

    // The sequence counter lives in `store.json`, and `flush()` drains the
    // append logs before it writes that file - so a crash in between, or a
    // `store.json` write that fails on a full disk, leaves notifications on disk
    // whose numbers the counter has forgotten. Handing one out twice is far worse
    // than skipping it: a device whose cursor has already passed that number
    // never receives the second alert, because `since()` compares strictly, and
    // no amount of reconnecting will ever deliver it.
    // Only a number that could have been issued counts. A torn or tampered line
    // may hold anything at all, and `1e30` taken at face value would push the
    // counter somewhere it can never come back from - every later `seq` absurd,
    // for the life of the store.
    const highest = this.historyCache.reduce(
      (max, n) => (Number.isSafeInteger(n.seq) && n.seq > max ? n.seq : max),
      0,
    );
    if (highest > this.data.seq) {
      this.data.seq = highest;
      this.markDirty();
    }

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

  private load(
    serverIdFactory: () => string,
  ): { data: StoreData; recoveredFrom: string | undefined } {
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
      ingestTokens: {},
    });

    if (!existsSync(this.file)) return { data: fresh(), recoveredFrom: undefined };
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as StoreData;
      if (!parsed || typeof parsed !== 'object') throw new Error('not a store document');
      const merged = { ...fresh(), ...parsed };

      // Every string-keyed collection is restored to an object if the document
      // does not supply one. `roles` was already guarded; the rest were not,
      // and a store truncated or hand-edited into `"devices": null` took the
      // hub down on its first lookup rather than starting with what survived.
      const blank = fresh();
      for (const key of COLLECTIONS) {
        const value = merged[key] as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          merged[key] = blank[key] as never;
        }
      }
      if (typeof merged.serverId !== 'string' || !merged.serverId) {
        merged.serverId = blank.serverId;
      }
      // A sequence that is not a number would hand every notification a `seq`
      // of NaN, and every replay cursor comparison would silently be false.
      if (!Number.isFinite(merged.seq)) merged.seq = 0;

      // Roles ship with the library and may gain new defaults between
      // versions; merge them in without clobbering operator edits.
      for (const role of defaultRoles()) merged.roles[role.name] ??= role;
      return { data: merged, recoveredFrom: undefined };
    } catch {
      // A truncated store must not stop the app that embedded us from booting.
      const backup = `${this.file}.corrupt-${Date.now()}`;
      let kept: string | undefined;
      try {
        renameSync(this.file, backup);
        kept = backup;
      } catch {
        /* best effort */
      }
      return { data: fresh(), recoveredFrom: kept ?? this.file };
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
    // A closed store schedules nothing. The retry inside `drain()` already checked
    // this, but an ordinary write after `close()` did not, so it armed a timer for
    // a store nobody is going to service - and on a hub that was stopped and
    // started again, that timer belongs to the instance that is gone.
    if (this.closed || this.saveTimer) return;
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
      if (this.compact(this.historyFile, this.historyCache)) {
        this.historyLines = this.historyCache.length;
      }
    }
    if (this.auditLines > this.limits.audit * 2) {
      if (this.compact(this.auditFile, this.auditCache)) {
        this.auditLines = this.auditCache.length;
      }
    }

    if (!this.dirty) return;
    const tmp = `${this.file}.tmp`;
    try {
      // Write-then-rename: a crash mid-write leaves the previous store intact
      // rather than a half-serialised file that would fail to parse on boot.
      writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      renameSync(tmp, this.file);
      // Cleared only once it is actually on disk. Clearing it first meant a
      // failed write was never retried: the store went on reporting itself
      // clean while memory and disk disagreed, and a device paired in that
      // window was gone after a restart.
      this.dirty = false;
    } catch {
      // The two writes above this one already refuse to take the process down
      // over a failed append. This one had no such guard, and it is reached
      // from a `setTimeout`, so a full disk or a read-only mount raised an
      // uncaught exception from a timer and killed the hub - the one outcome a
      // pager must not have. Left dirty and tried again instead; the moment
      // the disk comes back, the pending state is written.
      if (!this.closed) this.scheduleDrain();
    }
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

  /**
   * Rewrites a log from the cache, and says whether it managed to.
   *
   * It used to swallow the failure and return nothing, while both callers went on
   * to set the line count to the cache length as though the file had been
   * rewritten. On a full or read-only filesystem that left the counter
   * understating what is actually on disk, so later appends piled on top of
   * content the count no longer described - and the next boot could read back two
   * entries for one `seq`, which `since()` then replays twice.
   */
  private compact(file: string, entries: unknown[]): boolean {
    try {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, entries.map((e) => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });
      renameSync(tmp, file);
      return true;
    } catch {
      // Losing a compaction must never take down the app that embedded us; the
      // caller keeps its old count and tries again on the next write.
      return false;
    }
  }

  close(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.closed = true;
    this.flush();
  }

  get serverId(): string {
    return this.data.serverId;
  }

  /**
   * The hub's VAPID keypair, minting one the first time it is asked for.
   *
   * Lazy rather than generated at construction: a hub with Web Push turned off
   * never needs one, and a keypair that exists only because something might
   * want it later is a secret with no owner.
   */
  vapid(generate: () => { publicKey: string; privateKey: string }): {
    publicKey: string;
    privateKey: string;
  } {
    if (!this.data.vapid) {
      this.data.vapid = generate();
      this.markDirty();
    }
    return this.data.vapid;
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
      // A single pass for the minimum, not a filtered copy that is then sorted.
      // Behind a proxy the "IP" is a header an attacker chooses, so they decide
      // how often this runs - and sorting ten thousand records per failed
      // handshake turns a cheap request into expensive work for the hub.
      const now = Date.now();
      let oldest: BanRecord | undefined;
      for (const candidate of Object.values(this.data.bans)) {
        if (candidate.until >= now) continue;
        if (!oldest || candidate.lastFailureAt < oldest.lastFailureAt) oldest = candidate;
      }
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

  /* ----------------------------- ingest tokens ---------------------- */

  /**
   * Every token, revoked ones included.
   *
   * Revoked tokens are kept rather than deleted: an audit entry naming a token
   * that no longer exists is a dead end, and the id is what makes "this alert
   * came from CI" answerable months later. Callers that are authenticating a
   * request must skip them, which `findIngestToken` does.
   */
  ingestTokens(): IngestToken[] {
    return Object.values(this.data.ingestTokens ?? {});
  }

  ingestToken(id: string): IngestToken | undefined {
    return own(this.data.ingestTokens, id);
  }

  addIngestToken(token: IngestToken): void {
    if (unsafeKey(token.id)) return;
    this.data.ingestTokens[token.id] = token;
    this.markDirty();
  }

  updateIngestToken(id: string, patch: Partial<IngestToken>): IngestToken | undefined {
    const existing = own(this.data.ingestTokens, id);
    if (!existing || unsafeKey(id)) return undefined;
    const next = { ...existing, ...patch };
    this.data.ingestTokens[id] = next;
    this.markDirty();
    return next;
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
    // The cache already contains everything still queued for append. Writing it
    // out and then draining the queue would append those lines a second time, so
    // the queue is dropped rather than flushed - but only once the rewrite has
    // actually happened. Dropped first, it lost the queued lines from memory
    // while the file still held the content they were meant to replace.
    const pending = this.historyPending.slice();
    this.historyPending.length = 0;
    if (this.compact(this.historyFile, this.historyCache)) {
      this.historyLines = this.historyCache.length;
      return;
    }
    // The rewrite failed, so the lines still belong to the queue.
    this.historyPending.unshift(...pending);
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
