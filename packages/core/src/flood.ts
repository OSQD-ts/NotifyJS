import type { Notification, Severity } from '@osqd/notifyjs-protocol';
import type { FloodOptions } from './options.js';

interface Window {
  count: number;
  suppressed: number;
  /** Kept so the summary can quote what was actually repeating. */
  sample: Notification;
  timer: NodeJS.Timeout;
}

export interface FloodSummary {
  key: string;
  sample: Notification;
  /** How many were held back. */
  suppressed: number;
  /** Every occurrence in the window, including the ones already delivered. */
  total: number;
  windowMs: number;
}

/**
 * Collapses repeated identical alerts into one summary.
 *
 * A service stuck in a crash loop will happily call `notify.error()` a
 * thousand times a minute. Without this, every device buzzes a thousand times
 * and the alert becomes noise to be silenced - which is how real incidents get
 * missed.
 *
 * Nothing is discarded: past the burst allowance the repeats are counted, and
 * the count is released as a single notification when the window closes.
 */
export class FloodControl {
  private windows = new Map<string, Window>();

  constructor(
    private readonly opts: FloodOptions,
    private readonly onSummary: (summary: FloodSummary) => void,
    /**
     * Ceiling on concurrently tracked keys.
     *
     * The default key includes the notification title, so a caller emitting
     * distinct titles opens a window - and holds a timer - for each one. The
     * cap bounds that at the cost of not coalescing the overflow, which is
     * the safe direction to fail: an alert too many beats an alert lost.
     */
    private readonly maxWindows = 5_000,
  ) {}

  /**
   * Records this notification and says whether it should be held back.
   * Returns false for anything that must go out immediately.
   */
  shouldCoalesce(n: Notification, explicitKey?: string): boolean {
    if (!this.opts.enabled) return false;

    // `alwaysDeliver` exempts a severity from the *severity* rule, not from a key
    // the caller supplied. A `dedupeKey` is the caller saying "these are the same
    // thing", and the adapters say it while sending `critical`: the crash handler's
    // own comment is "one crash loop should not become a thousand pages", and a
    // crash loop is precisely a thousand identical criticals. Checking the
    // exemption first meant they all went out, each arming its own ack retry.
    //
    // Nothing is withheld that the burst allowance would have let through: the
    // first of a window always goes out, and what is collapsed is the repetition
    // after it, released as a summary.
    if (!explicitKey && this.opts.alwaysDeliver.includes(n.severity)) return false;

    const key = explicitKey ?? defaultKey(n);
    const existing = this.windows.get(key);

    if (!existing) {
      if (this.windows.size < this.maxWindows) this.open(key, n);
      return false;
    }

    existing.count += 1;
    existing.sample = n;
    if (existing.count <= this.opts.burst) return false;

    existing.suppressed += 1;
    return true;
  }

  private open(key: string, sample: Notification): void {
    const timer = setTimeout(() => this.close(key), this.opts.windowMs);
    timer.unref?.();
    this.windows.set(key, { count: 1, suppressed: 0, sample, timer });
  }

  private close(key: string): void {
    const window = this.windows.get(key);
    if (!window) return;
    this.windows.delete(key);
    if (window.suppressed === 0) return;

    this.onSummary({
      key,
      sample: window.sample,
      suppressed: window.suppressed,
      total: window.count,
      windowMs: this.opts.windowMs,
    });
  }

  /** Releases every pending summary; used on shutdown so nothing is lost. */
  flushAll(): void {
    for (const [key, window] of [...this.windows]) {
      clearTimeout(window.timer);
      this.close(key);
    }
  }

  stop(): void {
    for (const window of this.windows.values()) clearTimeout(window.timer);
    this.windows.clear();
  }
}

/**
 * Two alerts are "the same" when they would read identically to a human, so
 * the title is part of the key alongside the channel and severity.
 */
function defaultKey(n: Notification): string {
  return `${n.severity}|${n.channel}|${n.title}`;
}

/** Reports the true number of occurrences, not just the hidden ones. */
export function summaryTitle(summary: FloodSummary): string {
  return `${summary.sample.title} (x${summary.total} in ${formatWindow(summary.windowMs)})`;
}

function formatWindow(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const minutes = Math.round(ms / 60_000);
  return `${minutes} min`;
}

export type { Severity };
