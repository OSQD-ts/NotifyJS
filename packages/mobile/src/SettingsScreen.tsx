import { useEffect, useState } from 'react';
import {
  Alert,
  AppState,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SEVERITIES, type ClientPreferences, type Severity, type SourceState } from '@osqd/notifyjs-protocol';
import {
  canUseFullScreen,
  isBatteryOptimized,
  openBatterySettings,
  openFullScreenSettings,
} from '../modules/notifyjs-call';
import { currentVersion, downloadAndInstall, findAppUpdate, type AppUpdate } from './updates';
import { SEVERITY_COLORS, useTheme } from './theme';

interface Props {
  prefs: ClientPreferences;
  sources: SourceState[];
  onChange(patch: Partial<ClientPreferences>): void;
  onAddSource(): void;
  onToggleSource(id: string, enabled: boolean): void;
  onRemoveSource(id: string): void;
  onClose(): void;
}

export function SettingsScreen({
  prefs,
  sources,
  onChange,
  onAddSource,
  onToggleSource,
  onRemoveSource,
  onClose,
}: Props) {
  const t = useTheme();
  const [name, setName] = useState(prefs.deviceName);

  /* --- app updates ------------------------------------------------- */
  const [update, setUpdate] = useState<AppUpdate | undefined>();
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState<number | undefined>();
  const [updateError, setUpdateError] = useState<string | undefined>();

  // Checked once on open rather than on a timer: an update is worth knowing
  // about, not worth polling for.
  useEffect(() => {
    let cancelled = false;
    setChecking(true);
    findAppUpdate()
      .then((found) => {
        if (!cancelled) setUpdate(found);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const install = async () => {
    if (!update) return;
    setUpdateError(undefined);
    setProgress(0);
    try {
      await downloadAndInstall(update, setProgress);
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress(undefined);
    }
  };
  /**
   * Both of these are answered by system settings screens the user leaves the
   * app to visit, so they are re-read on every return rather than once - the
   * whole point of the warnings is that they disappear once acted on.
   */
  const [permissions, setPermissions] = useState(() => ({
    fullScreen: canUseFullScreen(),
    batteryOptimized: isBatteryOptimized(),
  }));

  useEffect(() => {
    const check = () =>
      setPermissions({ fullScreen: canUseFullScreen(), batteryOptimized: isBatteryOptimized() });
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') check();
    });
    return () => sub.remove();
  }, []);

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <View style={[styles.header, { backgroundColor: t.surface, borderColor: t.border }]}>
        <Text style={[styles.title, { color: t.text }]}>Settings</Text>
        <TouchableOpacity onPress={onClose} hitSlop={12} accessibilityRole="button">
          <Text style={[styles.done, { color: t.accent }]}>Done</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Section theme={t} title={`Sources (${sources.length})`}>
          {sources.length === 0 ? (
            <Text style={[styles.empty, { color: t.muted }]}>
              Not connected to anything yet. Add a hub to start receiving alerts.
            </Text>
          ) : null}

          {sources.map((source) => (
            <View key={source.id} style={[styles.row, { borderColor: t.border }]}>
              <View style={styles.rowText}>
                <Text style={[styles.rowLabel, { color: t.text }]}>{source.label}</Text>
                <Text style={[styles.rowHint, { color: t.muted }]}>
                  {source.url}
                  {source.role ? ` · ${source.role}` : ''}
                </Text>
                <Text
                  style={[
                    styles.status,
                    { color: source.status === 'ready' ? SEVERITY_COLORS.success : t.muted },
                  ]}
                >
                  {source.serviceDown ? 'not responding' : source.status}
                </Text>
              </View>
              <View style={styles.rowActions}>
                <Switch
                  value={source.enabled}
                  onValueChange={(v) => onToggleSource(source.id, v)}
                  accessibilityLabel={`Receive alerts from ${source.label}`}
                />
                <TouchableOpacity
                  hitSlop={10}
                  onPress={() =>
                    Alert.alert(
                      `Remove ${source.label}?`,
                      'This device will be forgotten by that hub. You will need a new pairing code to reconnect.',
                      [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Remove', style: 'destructive', onPress: () => onRemoveSource(source.id) },
                      ],
                    )
                  }
                >
                  <Text style={[styles.remove, { color: SEVERITY_COLORS.error }]}>Remove</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}

          <TouchableOpacity onPress={onAddSource} style={[styles.add, { backgroundColor: t.accent }]}>
            <Text style={styles.addText}>Add a source</Text>
          </TouchableOpacity>
        </Section>

        <Section theme={t} title="This device">
          <Row theme={t} label="Name" hint="How this device appears in each hub's device list">
            <View />
          </Row>
          <TextInput
            value={name}
            onChangeText={setName}
            onEndEditing={() => onChange({ deviceName: name })}
            placeholder="Phone"
            placeholderTextColor={t.muted}
            style={[styles.input, { color: t.text, backgroundColor: t.surface2, borderColor: t.border }]}
          />
        </Section>

        <Section theme={t} title="Alerts">
          <Row
            theme={t}
            label="Show at least"
            hint="Narrows what you see. It can never show more than your role allows."
          >
            <View />
          </Row>
          <View style={styles.chips}>
            {SEVERITIES.map((sev: Severity) => {
              const active = prefs.minSeverity === sev;
              return (
                <TouchableOpacity
                  key={sev}
                  onPress={() => onChange({ minSeverity: sev })}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  style={[
                    styles.chip,
                    {
                      borderColor: active ? t.accent : t.border,
                      backgroundColor: active ? t.accent : 'transparent',
                    },
                  ]}
                >
                  <Text style={{ color: active ? '#fff' : t.muted, fontSize: 13 }}>{sev}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Row theme={t} label="Sound">
            <Switch value={prefs.sound} onValueChange={(v) => onChange({ sound: v })} />
          </Row>
          <Row theme={t} label="Vibrate">
            <Switch value={prefs.vibrate} onValueChange={(v) => onChange({ vibrate: v })} />
          </Row>
        </Section>

        <Section theme={t} title="Calls">
          <Row theme={t} label="Speak the message" hint="Read the alert aloud when you answer">
            <Switch
              value={prefs.speech.enabled}
              onValueChange={(v) => onChange({ speech: { ...prefs.speech, enabled: v } })}
            />
          </Row>
          <Row theme={t} label="Speed" hint={`${prefs.speech.rate.toFixed(1)}x`}>
            <View style={styles.stepper}>
              <Stepper
                onPress={() => onChange({ speech: { ...prefs.speech, rate: prefs.speech.rate - 0.1 } })}
                label="−"
                theme={t}
              />
              <Stepper
                onPress={() => onChange({ speech: { ...prefs.speech, rate: prefs.speech.rate + 0.1 } })}
                label="+"
                theme={t}
              />
            </View>
          </Row>
          <Row theme={t} label="Repeat" hint={`${prefs.speech.repeat}x`}>
            <View style={styles.stepper}>
              <Stepper
                onPress={() => onChange({ speech: { ...prefs.speech, repeat: prefs.speech.repeat - 1 } })}
                label="−"
                theme={t}
              />
              <Stepper
                onPress={() => onChange({ speech: { ...prefs.speech, repeat: prefs.speech.repeat + 1 } })}
                label="+"
                theme={t}
              />
            </View>
          </Row>
        </Section>

        <Section theme={t} title="About">
          <Row theme={t} label="Version" hint={`NotifyJS ${currentVersion()}`}>
            <View />
          </Row>

          {checking ? (
            <Text style={[styles.rowHint, { color: t.muted, padding: 14, paddingTop: 0 }]}>
              Checking for updates...
            </Text>
          ) : update ? (
            <TouchableOpacity
              onPress={install}
              disabled={progress !== undefined}
              style={[styles.add, { backgroundColor: t.accent, opacity: progress !== undefined ? 0.6 : 1 }]}
            >
              <Text style={styles.addText}>
                {progress === undefined
                  ? `Update to ${update.release.tag}`
                  : `Downloading ${Math.round(progress * 100)}%`}
              </Text>
            </TouchableOpacity>
          ) : (
            <Text style={[styles.rowHint, { color: t.muted, padding: 14, paddingTop: 0 }]}>
              You are on the latest release.
            </Text>
          )}

          {updateError ? (
            <Text style={[styles.rowHint, { color: SEVERITY_COLORS.error, padding: 14, paddingTop: 0 }]}>
              {updateError}
            </Text>
          ) : null}
        </Section>

        {Platform.OS === 'android' ? (
          <Section theme={t} title="Background">
            <Row
              theme={t}
              label="Stay connected"
              hint="Keeps alerts arriving when the app is closed. Shows a permanent notification, which is what Android charges for the privilege."
            >
              <Switch value={prefs.keepAlive} onValueChange={(v) => onChange({ keepAlive: v })} />
            </Row>

            {!permissions.fullScreen ? (
              <TouchableOpacity onPress={openFullScreenSettings} style={[styles.warn, { borderColor: SEVERITY_COLORS.warning }]}>
                <Text style={[styles.warnTitle, { color: SEVERITY_COLORS.warning }]}>
                  Full-screen alerts are off
                </Text>
                <Text style={[styles.rowHint, { color: t.muted }]}>
                  Calls will appear as a banner instead of taking over the screen. Tap to allow.
                </Text>
              </TouchableOpacity>
            ) : null}

            {permissions.batteryOptimized ? (
              <TouchableOpacity onPress={openBatterySettings} style={[styles.warn, { borderColor: SEVERITY_COLORS.warning }]}>
                <Text style={[styles.warnTitle, { color: SEVERITY_COLORS.warning }]}>
                  Battery optimisation is on
                </Text>
                <Text style={[styles.rowHint, { color: t.muted }]}>
                  Android may suspend this app's connection while the screen is off, so alerts
                  arrive late or not at all. Tap, then choose NotifyJS and allow it to run
                  unrestricted.
                </Text>
              </TouchableOpacity>
            ) : null}
          </Section>
        ) : null}
      </ScrollView>
    </View>
  );
}

/**
 * Defined at module scope, not inside the screen.
 *
 * A component declared in a render body is a new function identity on every
 * render, so React treats it as a different component type and remounts its
 * whole subtree. That destroyed the device-name `TextInput` on every keystroke
 * - `onChangeText` set state, the screen re-rendered, and the field it had
 * just been typed into was replaced by a fresh one, dismissing the keyboard.
 */
function Section({
  title,
  theme,
  children,
}: {
  title: string;
  theme: ReturnType<typeof useTheme>;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: theme.muted }]}>{title.toUpperCase()}</Text>
      <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        {children}
      </View>
    </View>
  );
}

function Row({
  label,
  hint,
  theme,
  children,
}: {
  label: string;
  hint?: string;
  theme: ReturnType<typeof useTheme>;
  children: React.ReactNode;
}) {
  return (
    <View style={[styles.row, { borderColor: theme.border }]}>
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, { color: theme.text }]}>{label}</Text>
        {hint ? <Text style={[styles.rowHint, { color: theme.muted }]}>{hint}</Text> : null}
      </View>
      {children}
    </View>
  );
}

function Stepper({ onPress, label, theme }: { onPress(): void; label: string; theme: ReturnType<typeof useTheme> }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.stepBtn, { borderColor: theme.border, backgroundColor: theme.surface2 }]}
      accessibilityRole="button"
      accessibilityLabel={label === '−' ? 'decrease' : 'increase'}
    >
      <Text style={{ color: theme.text, fontSize: 18, lineHeight: 22 }}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingTop: 56,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  title: { fontSize: 20, fontWeight: '700' },
  done: { fontSize: 16, fontWeight: '600' },
  body: { padding: 14, paddingBottom: 48, gap: 20 },
  section: { gap: 8 },
  sectionTitle: { fontSize: 12, fontWeight: '700', letterSpacing: 0.8, marginLeft: 4 },
  card: { borderWidth: 1, borderRadius: 12, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  rowText: { flex: 1, gap: 2 },
  rowLabel: { fontSize: 15, fontWeight: '600' },
  rowHint: { fontSize: 12, lineHeight: 17 },
  rowActions: { alignItems: 'flex-end', gap: 8 },
  status: { fontSize: 11, fontWeight: '600' },
  remove: { fontSize: 12, fontWeight: '600' },
  empty: { padding: 14, fontSize: 14, lineHeight: 20 },
  add: { margin: 14, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  addText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  input: { margin: 14, marginTop: 0, borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 15 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 14, paddingTop: 0 },
  chip: { borderWidth: 1, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 12 },
  stepper: { flexDirection: 'row', gap: 8 },
  stepBtn: { borderWidth: 1, borderRadius: 8, width: 38, height: 34, alignItems: 'center', justifyContent: 'center' },
  warn: { margin: 14, marginTop: 0, borderWidth: 1, borderRadius: 10, padding: 12, gap: 4 },
  warnTitle: { fontSize: 14, fontWeight: '700' },
});
