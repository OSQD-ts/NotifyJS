import { useCallback, useEffect, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import * as Linking from 'expo-linking';

import { useNotify } from './src/useNotify';
import { PairScreen } from './src/PairScreen';
import { ScanScreen } from './src/ScanScreen';
import { FeedScreen } from './src/FeedScreen';
import { CallScreen } from './src/CallScreen';
import { PREF_KEYS, getPref, setPref } from './src/storage';
import { parsePairingLink } from '@notifyjs/protocol';
import { useTheme } from './src/theme';

/** Alerts should surface even while the app is in the foreground. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const DEFAULT_HUB = 'ws://192.168.1.10:7741';

export default function App() {
  const t = useTheme();
  const [hubUrl, setHubUrl] = useState(DEFAULT_HUB);
  const [deviceName, setDeviceName] = useState('Phone');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * A code waiting to be redeemed. Held here rather than passed to a client
   * method, because redeeming it usually changes the hub URL too - and that
   * rebuilds the client underneath.
   */
  const [pendingCode, setPendingCode] = useState<string | undefined>();

  /**
   * A notifyjs:// link, scanned by the system camera or tapped elsewhere.
   * Handled at this level so the hub URL is in place before the client that
   * will redeem the code is built.
   */
  useEffect(() => {
    const handle = (url: string | null) => {
      const link = url ? parsePairingLink(url) : undefined;
      if (!link) return;
      setHubUrl(link.hub);
      void setPref(PREF_KEYS.url, link.hub);
      setPendingCode(link.code);
    };
    void Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener('url', (e) => handle(e.url));
    return () => sub.remove();
  }, []);

  // Load saved preferences before creating the client, so it is built once
  // with the right URL rather than connecting to the default and reconnecting.
  useEffect(() => {
    void (async () => {
      const [url, name] = await Promise.all([getPref(PREF_KEYS.url), getPref(PREF_KEYS.name)]);
      if (url) setHubUrl(url);
      if (name) setDeviceName(name);
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    void Notifications.requestPermissionsAsync();
  }, []);

  if (!loaded) return <View style={[styles.root, { backgroundColor: t.bg }]} />;
  return (
    <Connected
      hubUrl={hubUrl}
      deviceName={deviceName}
      setHubUrl={setHubUrl}
      pendingCode={pendingCode}
      setPendingCode={setPendingCode}
      busy={busy}
      setBusy={setBusy}
    />
  );
}

interface ConnectedProps {
  hubUrl: string;
  deviceName: string;
  setHubUrl(url: string): void;
  pendingCode: string | undefined;
  setPendingCode(code: string | undefined): void;
  busy: boolean;
  setBusy(v: boolean): void;
}

function Connected({
  hubUrl,
  deviceName,
  setHubUrl,
  pendingCode,
  setPendingCode,
  busy,
  setBusy,
}: ConnectedProps) {
  const t = useTheme();
  const [scanning, setScanning] = useState(false);
  const { state, client, pair, clearCall, sync, unpair, snooze, unsnooze, snoozedUntil } =
    useNotify(hubUrl, deviceName, pendingCode);

  // The socket only lives while the app does. Coming back to the foreground
  // is the moment to ask the hub what was missed.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active' && state.status === 'ready') sync();
    });
    return () => sub.remove();
  }, [state.status, sync]);

  // Mirror incoming notifications into the OS tray so they persist after the
  // user swipes the app away.
  useEffect(() => {
    const latest = state.notifications[0];
    if (!latest) return;
    void Notifications.scheduleNotificationAsync({
      content: {
        title: `${latest.severity.toUpperCase()}: ${latest.title}`,
        body: latest.body ?? latest.channel,
      },
      trigger: null,
    });
  }, [state.notifications[0]?.id]);

  const handlePair = useCallback(
    async (code: string) => {
      setBusy(true);
      await setPref(PREF_KEYS.url, hubUrl);
      try {
        await pair(code);
      } finally {
        setBusy(false);
      }
    },
    [hubUrl, pair, setBusy],
  );

  // Once paired, drop the code so a later remount does not try to redeem a
  // single-use code a second time.
  useEffect(() => {
    if (state.paired && pendingCode) setPendingCode(undefined);
  }, [state.paired, pendingCode, setPendingCode]);

  const changeHub = useCallback(
    (url: string) => {
      setHubUrl(url);
      void setPref(PREF_KEYS.url, url);
    },
    [setHubUrl],
  );

  /**
   * A scanned link carries the hub address as well as the code. Both are
   * handed upwards: changing the URL rebuilds the client, and the new one
   * redeems the code once it exists.
   */
  const onScanned = useCallback(
    (link: { hub: string; code: string }) => {
      setScanning(false);
      changeHub(link.hub);
      setPendingCode(link.code);
    },
    [changeHub, setPendingCode],
  );

  if (state.activeCall) {
    const call = state.activeCall;
    return (
      <>
        <StatusBar style={t.isDark ? 'light' : 'dark'} />
        <CallScreen
          call={call}
          onAnswer={() => client.answerCall(call.id)}
          onDecline={() => {
            client.declineCall(call.id);
            clearCall();
          }}
          onFinished={() => {
            client.endCall(call.id);
            clearCall();
          }}
        />
      </>
    );
  }

  if (!state.paired) {
    if (scanning) {
      return (
        <>
          <StatusBar style="light" />
          <ScanScreen onScanned={onScanned} onCancel={() => setScanning(false)} />
        </>
      );
    }
    return (
      <>
        <StatusBar style={t.isDark ? 'light' : 'dark'} />
        <PairScreen
          onPair={handlePair}
          onScan={() => setScanning(true)}
          hubUrl={hubUrl}
          onChangeHub={changeHub}
          error={state.error}
          busy={busy}
        />
      </>
    );
  }

  return (
    <>
      <StatusBar style={t.isDark ? 'light' : 'dark'} />
      <FeedScreen
        notifications={state.notifications}
        status={state.status}
        role={state.role}
        hubName={client.serverName ?? 'NotifyJS'}
        snoozedUntil={snoozedUntil}
        serviceDown={state.serviceDown}
        onRefresh={sync}
        onUnpair={unpair}
        onSnooze={() => (snoozedUntil > Date.now() ? unsnooze() : snooze(30 * 60_000))}
      />
    </>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });
