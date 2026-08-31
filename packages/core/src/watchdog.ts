import type { Heartbeat, HeartbeatSpec } from '@osqd/notifyjs-protocol';

// The shapes themselves live in the protocol package: the hub returns them
// over `admin`, so they are part of the wire contract rather than of this
// file's implementation. Re-exported here so callers can keep importing them
// from beside the watchdog that enforces them.
export type { Heartbeat, HeartbeatSpec };

export interface HeartbeatEvent {
  heartbeat: Heartbeat;
  /** Milliseconds since the last check-in when the miss was noticed. */
  overdueBy: number;
}

/**
 * Watches for check-ins that never arrive.
 *
 * This is the answer to the one alert an embedded hub cannot otherwise send.
 * Everything else here reacts to something going wrong; a process that has
 * crashed, hung, or lost power reports nothing at all, and silence is
 * indistinguishable from health. A watchdog inverts that: the absence of a
 * signal is itself the signal.
 *
 * For it to mean anything, the watchdog has to live somewhere that can outlive
 * what it is watching - a standalone `notifyjs serve` hub, with the monitored
 * process checking in through a `RemoteNotifier`.
 */
export class Watchdog {
  private readonly beats = new Map<string, Heartbeat>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly onMissed: (event: HeartbeatEvent) => void,
    private readonly onRecovered: (heartbeat: Heartbeat) => void,
    private readonly tickMs = 5_000,
  ) {}

  /**
   * Registers (or updates) an expected check-in. Registering counts as the
   * first check-in, so a task is not immediately overdue at startup.
   */
  expect(name: string, spec: HeartbeatSpec): Heartbeat {
    const every = parseDuration(spec.every);
    if (every <= 0) throw new Error('a heartbeat interval must be greater than zero');

    const existing = this.beats.get(name);
    const beat: Heartbeat = {
      name,
      every,
      grace: spec.grace === undefined ? 0 : parseDuration(spec.grace),
      severity: spec.severity ?? 'critical',
      channel: spec.channel ?? 'heartbeat',
      description: spec.description,
      repeat: spec.repeat ?? false,
      lastSeenAt: existing?.lastSeenAt ?? Date.now(),
      missing: existing?.missing ?? false,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    this.beats.set(name, beat);
    this.ensureRunning();
    return beat;
  }

  /**
   * Records a check-in. Returns false when nothing was expecting one, so a
   * typo in the name is visible rather than silently doing nothing.
   */
  checkIn(name: string): boolean {
    const beat = this.beats.get(name);
    if (!beat) return false;

    beat.lastSeenAt = Date.now();
    if (beat.missing) {
      beat.missing = false;
      this.onRecovered(beat);
    }
    return true;
  }

  forget(name: string): boolean {
    const removed = this.beats.delete(name);
    if (this.beats.size === 0) this.stop();
    return removed;
  }

  list(): Heartbeat[] {
    return [...this.beats.values()];
  }

  get(name: string): Heartbeat | undefined {
    return this.beats.get(name);
  }

  /** Restores heartbeats across a restart, preserving their last check-in. */
  restore(beats: Heartbeat[]): void {
    for (const beat of beats) this.beats.set(beat.name, beat);
    if (this.beats.size > 0) this.ensureRunning();
  }

  /**
   * Resumes checking for overdue check-ins after a `stop()`.
   *
   * A hub that was stopped and started again went on *listing* its heartbeats
   * while no longer sweeping them: `heartbeats()` reported a job as watched and
   * no missed check-in would ever be raised again. Silence is the whole signal
   * here, so a watchdog that has quietly stopped watching is the worst possible
   * failure of it.
   */
  start(): void {
    if (this.beats.size > 0) this.ensureRunning();
  }

  private ensureRunning(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.tickMs);
    // The watchdog must not be the reason a process stays alive; it is a
    // passive observer of one that is running for its own reasons.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private sweep(): void {
    const now = Date.now();
    for (const beat of this.beats.values()) {
      const overdueBy = now - beat.lastSeenAt;
      const deadline = beat.every + beat.grace;
      if (overdueBy < deadline) continue;

      if (beat.missing && !beat.repeat) continue;

      // Re-arming the clock on a repeat keeps the reminder on the same
      // cadence as the check-in itself rather than firing every tick.
      if (beat.missing) beat.lastSeenAt = now;
      beat.missing = true;
      this.onMissed({ heartbeat: beat, overdueBy });
    }
  }
}

/**
 * Accepts `'24h'`, `'90s'`, `'15m'`, `'7d'` or plain milliseconds.
 *
 * Schedules are written by people, and `every: '24h'` is much harder to get
 * wrong than `every: 86400000`.
 */
export function parseDuration(value: number | string): number {
  if (typeof value === 'number') {
    // Zero is meaningful for `grace` ("no slack at all"); only a negative or
    // non-finite value is nonsense.
    if (!Number.isFinite(value) || value < 0) throw new Error(`invalid duration: ${value}`);
    return value;
  }

  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i.exec(value.trim());
  if (!match) throw new Error(`invalid duration: ${value} (try "30s", "15m", "24h")`);

  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const scale: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return amount * scale[unit]!;
}

/** Renders a duration the way the alert body should read it. */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1).replace(/\.0$/, '')}h`;
  return `${(ms / 86_400_000).toFixed(1).replace(/\.0$/, '')}d`;
}
