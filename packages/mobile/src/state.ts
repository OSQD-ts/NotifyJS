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
 * Whether a call still ringing has lost the hub that placed it.
 *
 * The hub treats a device whose socket closes as having declined, rings the
 * next person, and never sends this device a cancel - its later `taken` and
 * `missed` go only to devices still ringing. A connection that dropped
 * (a Wi-Fi handover), a revoke, or a removed source therefore left the phone
 * ringing and offering an Answer the hub would ignore, to somebody who then
 * believed they had taken a page that someone else had. An answered call is
 * left alone: its message is still worth hearing out.
 */
export function strandedCall(
  activeCall: SourcedCall | undefined,
  answeredCallId: string | undefined,
  sources: readonly SourceState[],
): boolean {
  if (!activeCall || callAnswered(activeCall, answeredCallId)) return false;
  const source = sources.find((s) => s.id === activeCall.sourceId);
  return source?.status !== 'ready';
}

/**
 * A ring length the native module can be handed: whole seconds, in range, or
 * nothing at all.
 *
 * The value comes from a hub and crosses into a Kotlin `Int`. A fraction or a
 * number past `Int` range fails that conversion, and a failed
 * `showIncomingCall` does not ring at all - so it is settled here, where the
 * worst a bad value can do is fall back to the default length.
 */
export function nativeRingSeconds(value: unknown): number | undefined {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.max(1, Math.min(Math.round(seconds), 15 * 60));
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
