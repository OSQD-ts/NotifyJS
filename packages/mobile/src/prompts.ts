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
