import { useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { formatPairingCode, isPairingCodeValid } from '@osqd/notifyjs-protocol';
import { useTheme } from './theme';

interface Props {
  onPair(code: string, url: string): Promise<void>;
  onScan(): void;
  hubUrl: string;
  onChangeHub(url: string): void;
  error?: string;
  busy: boolean;
  /** Present only when there is already a source to go back to. */
  onCancel?(): void;
}

export function PairScreen({ onPair, onScan, hubUrl, onChangeHub, error, busy, onCancel }: Props) {
  const t = useTheme();
  const [code, setCode] = useState('');
  const [localError, setLocalError] = useState<string | undefined>();
  const [editingHub, setEditingHub] = useState(false);

  const submit = async () => {
    // The checksum is verified on the phone, so a mistyped code never spends
    // an attempt against the hub's lockout counter.
    if (!isPairingCodeValid(code)) {
      setLocalError('That code is not valid. Check for a typo.');
      return;
    }
    setLocalError(undefined);
    await onPair(code, hubUrl);
  };

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: t.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }]}>
        <Image source={require('../assets/icon.png')} style={styles.mark} />
        <Text style={[styles.title, { color: t.text }]}>Add a source</Text>
        <Text style={[styles.sub, { color: t.muted }]}>
          Scan or enter a pairing code. A phone can watch as many hubs as you like.
        </Text>

        <TouchableOpacity
          onPress={onScan}
          style={[styles.button, styles.scanButton, { backgroundColor: t.accent }]}
        >
          <Text style={styles.buttonText}>Scan QR code</Text>
        </TouchableOpacity>

        <Text style={[styles.or, { color: t.muted }]}>or enter it manually</Text>

        <TextInput
          value={code}
          onChangeText={(v) => setCode(formatPairingCode(v))}
          placeholder="XXXX-XXXX-XXXX"
          placeholderTextColor={t.muted}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={14}
          style={[styles.code, { color: t.text, backgroundColor: t.surface2, borderColor: t.border }]}
        />

        {editingHub ? (
          <TextInput
            value={hubUrl}
            onChangeText={onChangeHub}
            placeholder="ws://192.168.1.10:7741"
            placeholderTextColor={t.muted}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.input, { color: t.text, backgroundColor: t.surface2, borderColor: t.border }]}
          />
        ) : (
          <TouchableOpacity onPress={() => setEditingHub(true)}>
            <Text style={[styles.hubLine, { color: t.muted }]}>Hub: {hubUrl} (tap to change)</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          onPress={submit}
          disabled={busy}
          style={[styles.button, { backgroundColor: t.accent, opacity: busy ? 0.6 : 1 }]}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Pair device</Text>}
        </TouchableOpacity>

        {(localError ?? error) ? (
          <Text style={styles.error}>{localError ?? error}</Text>
        ) : null}

        {onCancel ? (
          <TouchableOpacity onPress={onCancel} accessibilityRole="button">
            <Text style={[styles.hubLine, { color: t.muted }]}>Cancel</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'center', padding: 24 },
  card: { borderRadius: 16, borderWidth: 1, padding: 28, alignItems: 'center' },
  mark: { width: 64, height: 64, borderRadius: 16, marginBottom: 10 },
  title: { fontSize: 21, fontWeight: '700', marginBottom: 6 },
  sub: { fontSize: 14, textAlign: 'center', marginBottom: 22, lineHeight: 20 },
  scanButton: { marginTop: 4, marginBottom: 6 },
  or: { fontSize: 13, marginVertical: 8 },
  code: {
    width: '100%',
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    fontSize: 22,
    letterSpacing: 3,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  input: { width: '100%', borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 10, fontSize: 14 },
  hubLine: { fontSize: 13, marginTop: 12 },
  button: { width: '100%', borderRadius: 12, paddingVertical: 15, alignItems: 'center', marginTop: 18 },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  error: { color: '#ff6b6b', marginTop: 14, textAlign: 'center', fontSize: 14 },
});
