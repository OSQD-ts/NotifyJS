import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Platform, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Linking from 'expo-linking';
import * as Notifications from 'expo-notifications';
import { parsePairingLink } from '@osqd/notifyjs-protocol';

import {
  canUseFullScreen,
  dismissCall,
  isBatteryOptimized,
  openBatterySettings,
  openFullScreenSettings,
} from './modules/notifyjs-call';
import { useOneTimePrompt } from './src/prompts';
import { useSources } from './src/useSources';
import { PairScreen } from './src/PairScreen';
import { ScanScreen } from './src/ScanScreen';
import { FeedScreen } from './src/FeedScreen';
import { CallScreen } from './src/CallScreen';
import { SettingsScreen } from './src/SettingsScreen';
import { useTheme } from './src/theme';

/** Alerts should surface even while the app is in the foreground. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

type View_ = 'feed' | 'settings' | 'add' | 'scan';

/** The part of a hub address worth putting in front of someone. */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export default function App() {
  const t = useTheme();
  const { manager, sources, feed, activeCall, callAnswered, prefs, loaded, savePrefs, closeCall } =
    useSources();

  const [view, setView] = useState<View_>('feed');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [snoozedUntil, setSnoozedUntil] = useState(0);
  const [pendingUrl, setPendingUrl] = useState<string | undefined>();

  useEffect(() => {
    void Notifications.requestPermissionsAsync();
  }, []);

  const paired = loaded && sources.length > 0;

  /**
   * Android 14 withholds full-screen alerts from anything that is not a
   * dialler, and without them a call arriving on a locked phone is a banner
   * rather than a screen that takes over. Asked here rather than left to
   * Settings, because the person who needs it most is the one who never opens
   * Settings.
   *
   * Asked *once*. Granting it does not necessarily make it stay granted: on a
   * sideloaded build Google Play periodically re-revokes this permission,
   * because the app has no Play listing declaring it as a calling app. A modal
   * on every launch would therefore never stop, and would be asking the user
   * to redo something that will be undone again - so the recurring reminder
   * lives in Settings and this says plainly what to expect.
   */
  const fullScreenPrompt = useOneTimePrompt('fullScreen');
  useEffect(() => {
    if (Platform.OS !== 'android' || !paired) return;
    if (fullScreenPrompt.asked !== false) return;
    if (canUseFullScreen()) return;
    fullScreenPrompt.markAsked();
    Alert.alert(
      'Let calls take over the screen',
      'Android needs your permission before an alert can ring over a locked phone. Calls still ring out loud and arrive with Answer and Decline without it - they just will not take over the screen.\n\n' +
        'Android may switch this back off by itself on a sideloaded app. Settings will tell you when it has.',
      [
        { text: 'Not now', style: 'cancel' },
        { text: 'Allow', onPress: openFullScreenSettings },
      ],
    );
  }, [paired, fullScreenPrompt]);

  /**
   * The other permission that decides whether this app works at all.
   *
   * While battery optimisation applies, Android suspends the app once the
   * screen has been off for a while: the connection stops being read and
   * alerts queue up until the phone is picked up, which is precisely the
   * failure people report as "notifications only arrive when I open it". A
   * warning in Settings was not enough for the same reason the one above is
   * not - the person who needs it never goes looking. Once, for the same
   * reason as above.
   */
  const batteryPrompt = useOneTimePrompt('battery');
  useEffect(() => {
    if (Platform.OS !== 'android' || !paired) return;
    if (batteryPrompt.asked !== false) return;
    if (!isBatteryOptimized()) return;
    batteryPrompt.markAsked();
    Alert.alert(
      'Let alerts arrive while the screen is off',
      'Android is allowed to suspend this app in the background, which holds alerts back until you next open it. Allowing it to run unrestricted is what makes a pager a pager.',
      [
        { text: 'Not now', style: 'cancel' },
        { text: 'Settings', onPress: openBatterySettings },
      ],
    );
  }, [paired, batteryPrompt]);

  /** Adds a source, surfacing failures instead of leaving a dead screen. */
  const addSource = useCallback(
    async (input: { link?: string; url?: string; code: string }) => {
      setBusy(true);
      setError(undefined);
      try {
        await manager.add(input);
        setView('feed');
        setPendingUrl(undefined);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        // Show the failure rather than swallowing it: a link that fails while
        // the settings screen is open would otherwise do nothing visible.
        setView('add');
      } finally {
        setBusy(false);
      }
    },
    [manager],
  );

  /**
   * A notifyjs:// link opens the app straight into adding that hub. Handled
   * here rather than in a screen so it works whichever screen is showing.
   *
   * The link is *proposed*, never acted on by itself. Anything on the phone
   * can fire this scheme - a web page, another app - and a hub that pairs
   * itself in silence can ring the device, take over a locked screen and
   * speak whatever it likes through it. Scanning a QR code is a deliberate
   * act; following a link is not, so this one asks first and names the host
   * the user would be joining.
   */
  const handledLinks = useRef(new Set<string>());

  useEffect(() => {
    const handle = (url: string | null) => {
      if (!url) return;
      // `getInitialURL()` keeps returning the URL the app was *launched* with,
      // so without this every later link re-attempts that original one - and a
      // pairing code is single-use, so the retry always fails.
      if (handledLinks.current.has(url)) return;
      handledLinks.current.add(url);

      const link = parsePairingLink(url);
      if (!link) return;

      Alert.alert(
        'Join this hub?',
        `${hostOf(link.hub)} wants to send notifications and calls to this device. ` +
          'Only continue if you recognise it.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Join',
            onPress: () => void addSource({ url: link.hub, code: link.code }),
          },
        ],
      );
    };
    void Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener('url', (e) => handle(e.url));
    return () => sub.remove();
  }, [addSource]);

  // Coming back to the foreground is the moment to ask what was missed.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') manager.syncAll();
    });
    return () => sub.remove();
  }, [manager]);

  if (!loaded) return <View style={[styles.root, { backgroundColor: t.bg }]} />;

  if (activeCall) {
    const { call, sourceId } = activeCall;
    return (
      <>
        <StatusBar style={t.isDark ? 'light' : 'dark'} />
        <CallScreen
          call={call}
          speech={prefs.speech}
          answered={callAnswered}
          onAnswer={() => {
            manager.answerCall(sourceId, call.id);
            // The ring is over; leaving the notification up would let a second
            // Answer restart a call that is already being spoken.
            dismissCall(call.id);
          }}
          onDecline={() => {
            manager.declineCall(sourceId, call.id);
            closeCall(activeCall);
          }}
          onFinished={() => {
            manager.endCall(sourceId, call.id);
            closeCall(activeCall);
          }}
        />
      </>
    );
  }

  if (view === 'scan') {
    return (
      <>
        <StatusBar style="light" />
        <ScanScreen
          onScanned={(link) => void addSource({ url: link.hub, code: link.code })}
          onCancel={() => setView('add')}
        />
      </>
    );
  }

  // The pairing screen doubles as the empty state and as "add another source".
  if (view === 'add' || sources.length === 0) {
    return (
      <>
        <StatusBar style={t.isDark ? 'light' : 'dark'} />
        <PairScreen
          onPair={(code, url) => addSource({ url, code })}
          onScan={() => setView('scan')}
          hubUrl={pendingUrl ?? 'ws://192.168.1.10:7741'}
          onChangeHub={setPendingUrl}
          error={error}
          busy={busy}
          onCancel={sources.length > 0 ? () => setView('settings') : undefined}
        />
      </>
    );
  }

  if (view === 'settings') {
    return (
      <>
        <StatusBar style={t.isDark ? 'light' : 'dark'} />
        <SettingsScreen
          prefs={prefs}
          sources={sources}
          onChange={savePrefs}
          onAddSource={() => {
            setError(undefined);
            setView('add');
          }}
          onToggleSource={(id, enabled) => void manager.setEnabled(id, enabled)}
          onRemoveSource={(id) => void manager.remove(id)}
          onClose={() => setView('feed')}
        />
      </>
    );
  }

  return (
    <>
      <StatusBar style={t.isDark ? 'light' : 'dark'} />
      <FeedScreen
        feed={feed}
        sources={sources}
        snoozedUntil={snoozedUntil}
        onRefresh={() => manager.syncAll()}
        onSnooze={() => {
          if (snoozedUntil > Date.now()) {
            manager.unsnoozeAll();
            setSnoozedUntil(0);
          } else {
            manager.snoozeAll(30 * 60_000);
            setSnoozedUntil(Date.now() + 30 * 60_000);
          }
        }}
        onOpenSettings={() => setView('settings')}
      />
    </>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });
