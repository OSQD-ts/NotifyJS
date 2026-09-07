import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Network from 'expo-network';
import * as Notifications from 'expo-notifications';
import {
  SourceManager,
  defaultPreferences,
  normalizePreferences,
  type ClientPreferences,
  type Notification,
  type SourcedCall,
  type SourcedNotification,
  type SourceState,
} from '@osqd/notifyjs-protocol';

import {
  addCallActionListener,
  addWakeListener,
  consumeAnsweredCall,
  dismissCall,
  showAlert,
  showIncomingCall,
  startWatching,
  stopWatching,
} from '../modules/notifyjs-call';
import { nobleCrypto } from './crypto';
import { dismissPushFor, getPushToken } from './push';
import { secureStorage } from './storage';

const PREFS_KEY = 'notifyjs_preferences';

export interface FeedEntry extends SourcedNotification {
  resolvedAt?: number;
}

/**
 * Owns every hub subscription and the settings that shape them.
 *
 * Preferences are held in a ref as well as state: the SourceManager reads them
 * through callbacks on every incoming notification, and a stale closure there
 * would silently apply yesterday's settings.
 */
export function useSources() {
  const [prefs, setPrefs] = useState<ClientPreferences>(() => defaultPreferences('Phone'));
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const [sources, setSources] = useState<SourceState[]>([]);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [activeCall, setActiveCall] = useState<SourcedCall | undefined>();
  const [loaded, setLoaded] = useState(false);

  /**
   * The call answered from the notification rather than from the call screen.
   *
   * Kept as an id rather than a flag because the answer can land before the
   * call does: tapping Answer on a lock screen is often what starts the app,
   * and the call it refers to only reappears once the hub is resynced.
   */
  const [answeredCallId, setAnsweredCallId] = useState<string | undefined>();

  // The notification's Decline has to know which hub to tell, and the listener
  // that receives it is registered once, outside of any render.
  const activeCallRef = useRef<SourcedCall | undefined>();
  const setCall = useCallback((next: SourcedCall | undefined) => {
    activeCallRef.current = next;
    setActiveCall(next);
  }, []);

  const storage = useMemo(() => secureStorage(), []);

  const manager = useMemo(
    () =>
      new SourceManager({
        storage,
        crypto: nobleCrypto,
        createSocket: (url) => new WebSocket(url) as never,
        platform: Platform.OS,
        model: Device.modelName ?? undefined,
        deviceName: () => prefsRef.current.deviceName,
        minSeverity: () => prefsRef.current.minSeverity,
        // A phone in a tunnel produces the same silence as a dead hub; asking
        // the radio first is what stops it paging anyone over a lost signal.
        isOnline: async () => {
          try {
            const state = await Network.getNetworkStateAsync();
            return Boolean(state.isInternetReachable ?? state.isConnected);
          } catch {
            return false;
          }
        },
      }),
    [storage],
  );

  useEffect(() => {
    const offs = [
      manager.on('sources', setSources),

      manager.on('notification', (entry) => {
        setFeed((f) =>
          f.some((e) => e.notification.id === entry.notification.id && e.sourceId === entry.sourceId)
            ? f
            : [entry, ...f].slice(0, 300),
        );
        // Posted natively so it arrives whether the app is in front, behind,
        // or the screen is off - a JS scheduler only runs while JS does.
        showAlert(
          `${entry.sourceId}:${entry.notification.id}`,
          `${entry.notification.severity.toUpperCase()}: ${entry.notification.title}`,
          entry.notification.body ?? `${entry.sourceLabel} · ${entry.notification.channel}`,
          { sound: prefsRef.current.sound, vibrate: prefsRef.current.vibrate },
        );
        // If a wake-up push is what brought the app back, its notification is
        // still on screen saying the same thing as the one just posted.
        void dismissPushFor(entry.notification.id);
      }),

      manager.on('call', (entry) => {
        setCall(entry);
        showIncomingCall({
          id: entry.call.id,
          // Name the hub, since a phone may be watching several.
          from: `${entry.call.from} · ${entry.sourceLabel}`,
          message: entry.call.message,
          severity: entry.call.severity,
        });
      }),

      manager.on('call.cancel', ({ callId }) => {
        dismissCall(callId);
        setAnsweredCallId((id) => (id === callId ? undefined : id));
        if (activeCallRef.current?.call.id === callId) setCall(undefined);
      }),

      manager.on('resolve', ({ sourceId, ids }) =>
        setFeed((f) =>
          f.map((e) =>
            e.sourceId === sourceId && ids.includes(e.notification.id) && !e.resolvedAt
              ? { ...e, resolvedAt: Date.now() }
              : e,
          ),
        ),
      ),

      manager.on('service:missing', ({ sourceLabel, title, body }) =>
        showAlert(`watchdog-${sourceLabel}`, title, body ?? '', {
          sound: prefsRef.current.sound,
          vibrate: prefsRef.current.vibrate,
        }),
      ),

      // Answer and Decline pressed on the notification itself, which is the
      // only way to act on a call without unlocking the phone first.
      (() => {
        const sub = addCallActionListener(({ action, callId }) => {
          if (action === 'answer') {
            setAnsweredCallId(callId);
            return;
          }
          const entry = activeCallRef.current;
          if (entry?.call.id === callId) {
            manager.declineCall(entry.sourceId, callId);
            setCall(undefined);
          }
        });
        return () => sub?.remove();
      })(),
    ];

    void (async () => {
      const stored = await storage.get(PREFS_KEY);
      let parsed: unknown = null;
      try {
        parsed = stored ? JSON.parse(stored) : null;
      } catch {
        // Unreadable settings fall back to defaults rather than blocking start.
      }
      const restored = normalizePreferences(parsed, Device.deviceName ?? 'Phone');
      setPrefs(restored);
      prefsRef.current = restored;

      await manager.load();
      setLoaded(true);
    })();

    return () => {
      for (const off of offs) off();
      manager.disconnectAll();
    };
  }, [manager, storage, setCall]);

  // The foreground service is the difference between an app that alerts and
  // one that only alerts while you are looking at it. Keyed on the answer
  // rather than on the sources array, which is replaced on every hub event and
  // would otherwise restart the service dozens of times an hour.
  const shouldWatch = loaded && prefs.keepAlive && sources.some((s) => s.enabled);
  useEffect(() => {
    if (shouldWatch) startWatching('NotifyJS');
    else if (loaded) stopWatching();
  }, [loaded, shouldWatch]);

  /**
   * Resyncs when the OS says to, which is the only clock that keeps running.
   *
   * The service above keeps the process resident; it does not keep it
   * scheduled. Once the phone dozes, `setInterval` and `setTimeout` are
   * deferred against a clock that has stopped, so the client's keepalive never
   * notices the socket a NAT dropped an hour ago and the backoff it queued
   * never fires. Everything needed to recover was already there and simply had
   * no reason to run - which is why this hands it one rather than adding any
   * recovery logic of its own.
   *
   * `syncAll` is the whole response: it reconnects a client that is not ready,
   * replaces one whose socket has gone quiet, and otherwise just asks for
   * anything missed since the last ack.
   */
  useEffect(() => {
    const sub = addWakeListener(() => manager.syncAll());
    return () => sub?.remove();
  }, [manager]);

  /**
   * Hands each hub a wake-up token for this phone.
   *
   * Without this the whole push path is inert: the hub filters its wake-ups to
   * devices that have registered a token, and no device ever had. The feature
   * shipped complete on both sides of the wire and unconnected in the middle,
   * so a phone whose app had been swiped away simply heard nothing.
   *
   * Registered per source, because each subscription is a separate identity
   * with its own device record on its own hub. Re-registered whenever a source
   * comes back to ready, since Expo rotates tokens and a hub only keeps the
   * most recent one it was told about.
   */
  const registeredRef = useRef(new Set<string>());
  const readyIds = sources
    .filter((s) => s.status === 'ready')
    .map((s) => s.id)
    .sort()
    .join(',');

  useEffect(() => {
    const ready = new Set(readyIds ? readyIds.split(',') : []);
    // A source that dropped should register again when it returns.
    for (const id of registeredRef.current) {
      if (!ready.has(id)) registeredRef.current.delete(id);
    }

    const pending = [...ready].filter((id) => !registeredRef.current.has(id));
    if (pending.length === 0) return;

    let cancelled = false;
    void (async () => {
      // Resolves to undefined on a simulator, or when the user declined
      // notification permission - both ordinary outcomes, not failures.
      const token = await getPushToken();
      if (cancelled || !token) return;
      for (const id of pending) {
        registeredRef.current.add(id);
        manager.registerPush(id, token);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [manager, readyIds]);

  const savePrefs = useCallback(
    async (patch: Partial<ClientPreferences>) => {
      const next = normalizePreferences({ ...prefsRef.current, ...patch }, prefsRef.current.deviceName);
      prefsRef.current = next;
      setPrefs(next);
      await storage.set(PREFS_KEY, JSON.stringify(next));
    },
    [storage],
  );

  const clearFeed = useCallback(() => setFeed([]), []);

  /**
   * A wake-up push is a nudge, not the alert itself.
   *
   * The hub sends one only for a device it believes is not reading its socket,
   * and deliberately puts nothing in the payload beyond what arrived - the
   * real content comes over the connection. So the one thing that has to
   * happen when a push lands is the thing nothing here used to do: get the
   * connection back and ask for what was missed. Without this the push woke
   * the app, the app looked at a socket that had died while it slept, and the
   * feed stayed exactly as empty as before.
   */
  useEffect(() => {
    const sub = Notifications.addNotificationReceivedListener(() => manager.syncAll());
    return () => sub.remove();
  }, [manager]);

  /**
   * An Answer that started the app arrives as an intent extra, not an event -
   * the broadcast that carried it ran before there was any JavaScript to hear
   * it. Re-read on every return to the foreground, since that is the moment
   * the launch could have happened.
   */
  useEffect(() => {
    const take = () => {
      const id = consumeAnsweredCall();
      if (id) setAnsweredCallId(id);
    };
    take();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') take();
    });
    return () => sub.remove();
  }, []);

  const closeCall = useCallback(
    (entry?: SourcedCall) => {
      if (entry) dismissCall(entry.call.id);
      setAnsweredCallId(undefined);
      setCall(undefined);
    },
    [setCall],
  );

  return {
    manager,
    sources,
    feed,
    activeCall,
    /** True when this call was already answered from the notification. */
    callAnswered: activeCall !== undefined && activeCall.call.id === answeredCallId,
    prefs,
    loaded,
    savePrefs,
    clearFeed,
    closeCall,
  };
}

export type { Notification, SourceState, SourcedCall };
