import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import {
  NotifyClient,
  type CallRequest,
  type ConnectionStatus,
  type Notification,
} from '@osqd/notifyjs-protocol';
import * as Network from 'expo-network';
import {
  dismissCall,
  showAlert,
  showIncomingCall,
  startWatching,
  stopWatching,
} from '../modules/notifyjs-call';
import { nobleCrypto } from './crypto';
import { secureStorage } from './storage';
import { getPushToken } from './push';

export interface NotifyState {
  status: ConnectionStatus;
  /** Set when this phone has stopped hearing from the hub. */
  serviceDown: { title: string; body?: string; silentForMs: number } | undefined;
  role: string | undefined;
  notifications: Notification[];
  activeCall: CallRequest | undefined;
  paired: boolean;
  error: string | undefined;
}

/**
 * Owns the single NotifyClient for the app and mirrors it into React state.
 *
 * The client is created once per hub URL and kept in a ref: re-creating it on
 * every render would drop the socket and re-run the handshake constantly.
 */
export function useNotify(url: string, deviceName: string, pendingCode?: string) {
  const [state, setState] = useState<NotifyState>({
    status: 'idle',
    role: undefined,
    notifications: [],
    activeCall: undefined,
    paired: false,
    error: undefined,
    serviceDown: undefined,
  });

  const client = useMemo(
    () =>
      new NotifyClient({
        url,
        crypto: nobleCrypto,
        storage: secureStorage(),
        createSocket: (target) => new WebSocket(target) as never,
        deviceName,
        platform: Platform.OS,
        model: Device.modelName ?? undefined,
        autoReconnect: true,
        /**
         * A phone in a tunnel produces exactly the same silence as a dead
         * server. Checking the radio first is what keeps this from paging
         * someone every time they take the underground.
         */
        isOnline: async () => {
          try {
            const state = await Network.getNetworkStateAsync();
            return Boolean(state.isInternetReachable ?? state.isConnected);
          } catch {
            return false;
          }
        },
      }),
    [url, deviceName],
  );

  const clientRef = useRef(client);
  clientRef.current = client;

  useEffect(() => {
    const offs = [
      client.on('status', (status) =>
        setState((s) => ({ ...s, status, error: status === 'error' ? s.error : undefined })),
      ),
      client.on('ready', () => {
        setState((s) => ({ ...s, role: client.role, paired: true, error: undefined }));
        // Android reclaims the process once the app leaves the screen, taking
        // the socket with it. This keeps both alive so alerts still arrive
        // when the app is backgrounded, swiped away, or the screen is off.
        startWatching(client.serverName ?? 'NotifyJS');
        // Registered on every connect: Expo rotates tokens, and the hub only
        // ever keeps the most recent one.
        void getPushToken().then((token) => {
          if (token) client.registerPush(token);
        });
      }),
      client.on('notification', (n) => {
        let isNew = false;
        setState((s) => {
          // Unacknowledged notifications are re-sent by the hub, so the same
          // id can arrive more than once.
          if (s.notifications.some((existing) => existing.id === n.id)) return s;
          isNew = true;
          return { ...s, notifications: [n, ...s.notifications].slice(0, 200) };
        });

        if (isNew) {
          // Posted natively rather than through a JS scheduler, so it shows
          // whether the app is in front, behind, or the screen is off.
          showAlert(n.id, `${n.severity.toUpperCase()}: ${n.title}`, n.body ?? n.channel);
        }
        client.ack([n.id], { seq: n.seq });
      }),
      client.on('call', (call) => {
        setState((s) => ({ ...s, activeCall: call }));
        // The in-app screen only exists while the app is on screen. This is
        // what reaches a locked phone sitting on a bedside table.
        showIncomingCall({
          id: call.id,
          from: call.from,
          message: call.message,
          severity: call.severity,
        });
      }),

      /**
       * The hub cannot tell you it has died. This phone can, because it is the
       * one that stopped hearing it.
       */
      client.on('service:missing', ({ spec, silentForMs }) => {
        setState((s) => ({
          ...s,
          serviceDown: { title: spec.alert.title, body: spec.alert.body, silentForMs },
        }));
        // Native, for the same reason as ordinary alerts: the moment worth
        // reporting is usually the moment the app is not on screen.
        showAlert(`watchdog-${spec.alert.title}`, spec.alert.title, spec.alert.body ?? '');
      }),

      client.on('service:back', () => setState((s) => ({ ...s, serviceDown: undefined }))),

      // An announced restart is not an incident.
      client.on('service:bye', () => setState((s) => ({ ...s, serviceDown: undefined }))),
      client.on('call.cancel', ({ callId }) => {
        dismissCall(callId);
        setState((s) => (s.activeCall?.id === callId ? { ...s, activeCall: undefined } : s));
      }),
      // The condition ended, so the alert should stop taking up the screen.
      client.on('resolve', ({ ids }) =>
        setState((s) => ({
          ...s,
          notifications: s.notifications.map((n) =>
            ids.includes(n.id) && !n.resolvedAt ? { ...n, resolvedAt: Date.now() } : n,
          ),
        })),
      ),
      client.on('paired', () => setState((s) => ({ ...s, paired: true, error: undefined }))),
      client.on('revoked', () =>
        setState((s) => ({
          ...s,
          paired: false,
          activeCall: undefined,
          error: 'This device was revoked by an administrator.',
        })),
      ),
      client.on('error', (err) =>
        setState((s) => ({
          ...s,
          error:
            err.code === 'pair_failed'
              ? 'Pairing failed. The code may be expired or already used.'
              : err.message,
        })),
      ),
    ];

    void (async () => {
      // Anything thrown in here used to vanish into an unhandled rejection,
      // leaving the pairing screen sitting there with no explanation. A
      // failure the user cannot see is worse than one they can.
      try {
        // An explicit code is an explicit instruction: scanning one while
        // already paired means "join this hub instead", so the old identity
        // is discarded rather than used to authenticate against a hub that
        // has never heard of it.
        if (pendingCode && (await client.isPaired())) {
          await client.forgetCredentials();
        }

        const paired = await client.isPaired();
        setState((s) => ({ ...s, paired }));

        if (paired) {
          await client.connect();
        } else if (pendingCode) {
          // A scanned link changes the hub URL, which rebuilds this client.
          // The code has to be redeemed by whichever instance ends up owning
          // the socket - redeeming it on the outgoing one pairs nothing.
          await client.pair(pendingCode);
        } else {
          setState((s) => ({ ...s, status: 'unpaired' }));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[notifyjs] connect failed:', message);
        setState((s) => ({ ...s, status: 'error', error: message }));
      }
    })();

    return () => {
      for (const off of offs) off();
      client.disconnect();
    };
  }, [client, pendingCode]);

  const pair = useCallback((code: string) => clientRef.current.pair(code), []);

  const clearCall = useCallback((callId?: string) => {
    // The notification must go with the call, or a ringing entry outlives the
    // incident on the lock screen.
    if (callId) dismissCall(callId);
    setState((s) => {
      if (s.activeCall) dismissCall(s.activeCall.id);
      return { ...s, activeCall: undefined };
    });
  }, []);

  const sync = useCallback(() => clientRef.current.sync(), []);

  const [snoozedUntil, setSnoozedUntil] = useState(0);

  /** Quiets this phone for a while. Critical alerts still come through. */
  const snooze = useCallback((durationMs: number) => {
    clientRef.current.snooze(durationMs);
    setSnoozedUntil(Date.now() + durationMs);
  }, []);

  const unsnooze = useCallback(() => {
    clientRef.current.unsnooze();
    setSnoozedUntil(0);
  }, []);

  const unpair = useCallback(async () => {
    // Nothing left to listen for, so stop paying the battery cost.
    stopWatching();
    clientRef.current.disconnect();
    await clientRef.current.forgetCredentials();
    setState((s) => ({ ...s, paired: false, status: 'unpaired', notifications: [] }));
  }, []);

  return {
    state,
    client: clientRef.current,
    pair,
    clearCall,
    sync,
    unpair,
    snooze,
    unsnooze,
    snoozedUntil,
  };
}
