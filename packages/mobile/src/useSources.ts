import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { Notification, SourcedCall, SourceState } from '@osqd/notifyjs-protocol';

import { hub, type FeedEntry, type HubState } from './hub';

/**
 * Subscribes the screens to the hub connection.
 *
 * This used to *own* the connection - the manager, the feed, the settings and
 * every native side effect were created inside it - which made all of it a
 * possession of the React tree. It is now a view onto `hub`, which outlives
 * any tree, so unmounting a screen no longer takes the sockets with it and a
 * process started without a UI still has somewhere to connect from.
 *
 * `useSyncExternalStore` rather than an effect and a `useState`: the store can
 * change between render and subscribe - a notification arriving in that window
 * is exactly the case this app exists for - and this is the hook that is built
 * not to miss it.
 */
export function useSources() {
  const state = useSyncExternalStore<HubState>(hub.subscribe, hub.getState, hub.getState);

  // Idempotent, so it does not matter whether a screen or a headless task got
  // here first.
  useEffect(() => {
    void hub.start();
  }, []);

  const savePrefs = useCallback(
    (patch: Parameters<typeof hub.savePrefs>[0]) => hub.savePrefs(patch),
    [],
  );
  const clearFeed = useCallback(() => hub.clearFeed(), []);
  const closeCall = useCallback((entry?: SourcedCall) => hub.closeCall(entry), []);

  return {
    manager: hub.manager,
    sources: state.sources,
    feed: state.feed,
    activeCall: state.activeCall,
    /** True when this call was already answered from the notification. */
    callAnswered: hub.callAnswered,
    prefs: state.prefs,
    loaded: state.loaded,
    savePrefs,
    clearFeed,
    closeCall,
  };
}

export type { FeedEntry, Notification, SourceState, SourcedCall };
