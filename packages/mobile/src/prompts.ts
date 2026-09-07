import { useCallback, useEffect, useState } from 'react';

import { secureStorage } from './storage';

/**
 * One-time permission prompts, remembered across launches.
 *
 * Some of what this app needs is a system setting the user has to go and
 * change, and asking with a modal is the only way to reach somebody who will
 * never open Settings. Asking *again on every launch* is a different thing: it
 * trains people to dismiss the dialog without reading it, and for full-screen
 * intents it is worse than useless - Google Play re-revokes that permission on
 * a sideloaded app whatever the user does, so the modal would return forever
 * and never stay answered.
 *
 * So each prompt is asked once. The standing reminder lives in Settings, where
 * a condition that keeps coming back belongs, and where acting on it is a
 * choice rather than an interruption.
 */
const ASKED_PREFIX = 'notifyjs.asked.';

export type PromptKey = 'fullScreen' | 'battery';

export function useOneTimePrompt(key: PromptKey): {
  /** Undefined until storage has been read; asking before then would double up. */
  asked: boolean | undefined;
  markAsked: () => void;
} {
  const [asked, setAsked] = useState<boolean | undefined>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await secureStorage().get(`${ASKED_PREFIX}${key}`);
      if (!cancelled) setAsked(stored === '1');
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);

  const markAsked = useCallback(() => {
    // Set locally first: the write is asynchronous, and a second render must
    // not get another chance to ask while it is still in flight.
    setAsked(true);
    void secureStorage()
      .set(`${ASKED_PREFIX}${key}`, '1')
      .catch(() => {
        // A prompt that asks twice is a far smaller problem than one that
        // blocks startup over a failed write.
      });
  }, [key]);

  return { asked, markAsked };
}

/**
 * A prompt that comes back, for a setting that stays fixed once fixed.
 *
 * The reasoning above turns on full-screen intents being un-answerable: Play
 * revokes them again on a sideloaded build whatever the user does, so a
 * recurring modal would nag forever about something nobody can settle.
 * Battery optimisation is the opposite. Granting the exemption sticks, and the
 * moment it is granted this stops asking for good - so the only person who
 * sees it twice is the one for whom it is still true.
 *
 * That matters because of what the setting costs when it is wrong. It does not
 * degrade the app, it silently defeats it: the connection stops being read
 * while the screen is off and every alert waits for the phone to be picked up.
 * Asked once, dismissed once, and a pager quietly stops being a pager - which
 * is the failure this whole module exists to prevent.
 */
export function useRecurringPrompt(
  key: PromptKey,
  cooldownMs: number,
): {
  /** Undefined until storage has been read; asking before then would double up. */
  asked: boolean | undefined;
  markAsked: () => void;
} {
  const [asked, setAsked] = useState<boolean | undefined>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await secureStorage().get(`${ASKED_PREFIX}${key}`);
      if (cancelled) return;
      const at = Number(stored);
      // Anything unreadable - including the bare '1' written by the one-time
      // version of this prompt before it grew a cooldown - counts as long ago,
      // so an upgraded install asks once more and then settles into the cycle.
      setAsked(Number.isFinite(at) && at > 0 && Date.now() - at < cooldownMs);
    })();
    return () => {
      cancelled = true;
    };
  }, [key, cooldownMs]);

  const markAsked = useCallback(() => {
    setAsked(true);
    void secureStorage()
      .set(`${ASKED_PREFIX}${key}`, String(Date.now()))
      .catch(() => {
        // A prompt that asks twice is a far smaller problem than one that
        // blocks startup over a failed write.
      });
  }, [key]);

  return { asked, markAsked };
}
