import type { ClientPreferences, SourcedCall, SourcedNotification, SourceState } from '@osqd/notifyjs-protocol';

/**
 * The decisions this app makes that have nothing to do with a phone.
 *
 * Everything else in the mobile package reaches for React Native, a native
 * module or a preferences store the moment it is imported, which is why none
 * of it was ever tested: there was no way to load a file and ask it a
 * question. The rules below are the ones worth getting right - what belongs in
 * the feed, when the foreground service should be running, whether a call was
 * already answered - and they are all pure, so they live here where a test can
 * reach them.
 */

export interface FeedEntry extends SourcedNotification {
  resolvedAt?: number;
}

/**
 * How much history the feed keeps.
 *
 * Bounded because this list is held in memory on a device that is expected to
 * run for weeks: a busy hub would otherwise grow it until the app was killed
 * for the wrong reason.
 */
export const FEED_LIMIT = 300;

/**
 * Adds an alert to the feed, ignoring one that is already there.
 *
 * Keyed on the notification *and* its source, not the id alone: ids are unique
 * per hub, and a phone watching two hubs can legitimately hold the same id
 * twice. Duplicates arrive normally rather than exceptionally - a reconnect
 * replays from the ack cursor, so anything unacknowledged is delivered again.
 */
export function addToFeed(feed: FeedEntry[], entry: SourcedNotification): FeedEntry[] {
  const known = feed.some(
    (e) => e.notification.id === entry.notification.id && e.sourceId === entry.sourceId,
  );
  if (known) return feed;
  return [entry, ...feed].slice(0, FEED_LIMIT);
}

/**
 * Marks alerts as resolved, leaving already-resolved ones alone.
 *
 * The timestamp is what the screen renders, so overwriting it on a repeat
 * would keep moving "resolved 20 minutes ago" back to "just now" every time
 * the hub replayed the same resolution.
 */
export function markResolved(
  feed: FeedEntry[],
  sourceId: string,
  ids: readonly string[],
  now: number,
): FeedEntry[] {
  return feed.map((e) =>
    e.sourceId === sourceId && ids.includes(e.notification.id) && !e.resolvedAt
      ? { ...e, resolvedAt: now }
      : e,
  );
}

/**
 * Whether the foreground service should be running.
 *
 * Both halves matter. Keeping a process alive costs battery and a permanent
 * notification, so it is not done for somebody who turned it off - and not
 * done for a phone with no enabled source either, where there is no connection
 * to keep alive in the first place.
 */
export function shouldWatch(prefs: ClientPreferences, sources: readonly SourceState[]): boolean {
  return prefs.keepAlive && sources.some((s) => s.enabled);
}

/**
 * Whether the call on screen is the one already answered from the
 * notification. Compared by id rather than tracked as a flag, because the
 * answer routinely arrives before the call does: tapping Answer on a lock
 * screen is often what starts the app.
 */
export function callAnswered(
  activeCall: SourcedCall | undefined,
  answeredCallId: string | undefined,
): boolean {
  return activeCall !== undefined && activeCall.call.id === answeredCallId;
}

/**
 * Whether a recurring prompt is still inside its quiet period.
 *
 * Anything unreadable counts as long ago, so an install that predates the
 * stored timestamp - it used to be the string '1' - asks once more and then
 * settles into the cycle, rather than either nagging or going silent forever.
 */
export function promptIsFresh(stored: string | null, cooldownMs: number, now: number): boolean {
  const at = Number(stored);
  return Number.isFinite(at) && at > 0 && now - at < cooldownMs;
}
