import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Network from 'expo-network';
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

import { dismissCall, showAlert, showIncomingCall, startWatching, stopWatching } from '../modules/notifyjs-call';
import { nobleCrypto } from './crypto';
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
      }),

      manager.on('call', (entry) => {
        setActiveCall(entry);
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
        setActiveCall((c) => (c?.call.id === callId ? undefined : c));
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
  }, [manager, storage]);

  // The foreground service is the difference between an app that alerts and
  // one that only alerts while you are looking at it.
  useEffect(() => {
    if (!loaded) return;
    const anyConnected = sources.some((s) => s.enabled);
    if (prefs.keepAlive && anyConnected) startWatching('NotifyJS');
    else stopWatching();
  }, [loaded, prefs.keepAlive, sources]);

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

  const closeCall = useCallback((entry?: SourcedCall) => {
    if (entry) dismissCall(entry.call.id);
    setActiveCall(undefined);
  }, []);

  return { manager, sources, feed, activeCall, prefs, loaded, savePrefs, clearFeed, closeCall };
}

export type { Notification, SourceState, SourcedCall };
