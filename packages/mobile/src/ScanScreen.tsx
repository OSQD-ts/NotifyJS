import { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { parsePairingLink, type PairingLink } from '@notifyjs/protocol';
import { useTheme } from './theme';

interface Props {
  onScanned(link: PairingLink): void;
  onCancel(): void;
}

/**
 * Scans a pairing QR code.
 *
 * The link carries both the hub address and the code, so scanning replaces
 * typing `ws://192.168.1.10:7741` and a twelve-character code on a phone
 * keyboard - by far the worst part of joining a hub.
 */
export function ScanScreen({ onScanned, onCancel }: Props) {
  const t = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [handled, setHandled] = useState(false);
  const [error, setError] = useState<string | undefined>();

  if (!permission) {
    return <View style={[styles.root, { backgroundColor: t.bg }]} />;
  }

  if (!permission.granted) {
    return (
      <View style={[styles.root, styles.centered, { backgroundColor: t.bg }]}>
        <Text style={[styles.explain, { color: t.text }]}>
          NotifyJS needs the camera to scan a pairing code.
        </Text>
        <TouchableOpacity
          onPress={requestPermission}
          style={[styles.button, { backgroundColor: t.accent }]}
        >
          <Text style={styles.buttonText}>Allow camera</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onCancel}>
          <Text style={[styles.link, { color: t.muted }]}>Enter a code instead</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: '#000' }]}>
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          // The camera fires continuously; one accepted scan is enough.
          if (handled) return;
          const link = parsePairingLink(data);
          if (!link) {
            setError('That QR code is not a NotifyJS pairing code.');
            return;
          }
          setHandled(true);
          onScanned(link);
        }}
      />

      <View style={styles.overlay}>
        <Text style={styles.hint}>Point at the pairing code shown by your hub</Text>
        <View style={styles.frame} />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <TouchableOpacity onPress={onCancel} style={styles.cancel}>
          <Text style={styles.buttonText}>Enter a code instead</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  centered: { alignItems: 'center', justifyContent: 'center', padding: 32, gap: 16 },
  explain: { fontSize: 16, textAlign: 'center', lineHeight: 23 },
  overlay: { flex: 1, alignItems: 'center', justifyContent: 'space-between', paddingVertical: 90 },
  hint: { color: '#fff', fontSize: 15, textAlign: 'center', paddingHorizontal: 32 },
  frame: {
    width: 240,
    height: 240,
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.85)',
    borderRadius: 20,
  },
  error: { color: '#ff6b6b', textAlign: 'center', paddingHorizontal: 24 },
  button: { borderRadius: 12, paddingVertical: 14, paddingHorizontal: 26 },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  cancel: { backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 999, paddingVertical: 12, paddingHorizontal: 22 },
  link: { fontSize: 14, textDecorationLine: 'underline' },
});
