import { useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, Vibration, View } from 'react-native';
import * as Speech from 'expo-speech';
import * as Haptics from 'expo-haptics';
import { useKeepAwake } from 'expo-keep-awake';
import type { CallRequest } from '@osqd/notifyjs-protocol';
import { SEVERITY_COLORS, useTheme } from './theme';

interface Props {
  call: CallRequest;
  /** The listener's own speech settings, which win over the call's defaults. */
  speech: { enabled: boolean; rate: number; pitch: number; lang: string; repeat: number };
  onAnswer(): void;
  onDecline(): void;
  onFinished(): void;
}

/** Ring cadence: buzz, pause, buzz - repeated until answered or cancelled. */
const RING_PATTERN = [0, 700, 800, 700, 1600];

/**
 * The incoming-call screen.
 *
 * This is an in-app full-screen call, which works in Expo Go and in a plain
 * managed build. For a true native call UI - ringing over the lock screen the
 * way a phone call does - see the CallKit / ConnectionService notes in the
 * README; the protocol side needs no changes for it.
 */
export function CallScreen({ call, speech, onAnswer, onDecline, onFinished }: Props) {
  const t = useTheme();
  const [speaking, setSpeaking] = useState(false);
  useKeepAwake();

  // Ring until the user acts. The cleanup runs when the call is answered,
  // declined, or cancelled by the hub because another device picked up.
  useEffect(() => {
    if (speaking) return;
    Vibration.vibrate(RING_PATTERN, true);
    return () => Vibration.cancel();
  }, [speaking]);

  useEffect(() => {
    return () => {
      Vibration.cancel();
      Speech.stop();
    };
  }, []);

  const answer = () => {
    Vibration.cancel();
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSpeaking(true);
    onAnswer();

    if (!speech.enabled) {
      // Answering still counts; the person simply does not want it read out.
      onFinished();
      return;
    }

    const repeats = Math.max(1, Math.min(speech.repeat || call.repeat || 1, 5));
    let spoken = 0;

    const speakOnce = () => {
      Speech.speak(call.message, {
        language: speech.lang || call.lang || 'en-US',
        rate: speech.rate || call.rate || 1,
        pitch: speech.pitch || call.pitch || 1,
        onDone: () => (++spoken < repeats ? speakOnce() : onFinished()),
        // A TTS failure must still close the call, or the screen would be
        // stuck with no way back to the feed.
        onError: onFinished,
        onStopped: onFinished,
      });
    };
    speakOnce();
  };

  const decline = () => {
    Vibration.cancel();
    Speech.stop();
    onDecline();
  };

  const accent = SEVERITY_COLORS[call.severity] ?? SEVERITY_COLORS.critical;

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <View style={styles.top}>
        <Text style={[styles.label, { color: t.muted }]}>
          {speaking ? 'SPEAKING' : 'INCOMING ALERT'}
        </Text>
        <Text style={[styles.from, { color: t.text }]}>{call.from}</Text>
        <Text style={[styles.severity, { color: accent }]}>{call.severity.toUpperCase()}</Text>
        <Text style={[styles.message, { color: t.text }]}>{call.message}</Text>
      </View>

      {speaking ? (
        <TouchableOpacity
          onPress={() => {
            Speech.stop();
            onFinished();
          }}
          style={[styles.button, styles.wide, { backgroundColor: '#ff6b6b' }]}
        >
          <Text style={styles.buttonText}>Hang up</Text>
        </TouchableOpacity>
      ) : (
        <View style={styles.actions}>
          <TouchableOpacity onPress={decline} style={[styles.button, { backgroundColor: '#ff6b6b' }]}>
            <Text style={styles.buttonText}>Decline</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={answer} style={[styles.button, { backgroundColor: '#35c48a' }]}>
            <Text style={styles.buttonText}>Answer</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'space-between', padding: 28, paddingTop: 96, paddingBottom: 64 },
  top: { alignItems: 'center' },
  label: { fontSize: 12, letterSpacing: 2, fontWeight: '600' },
  from: { fontSize: 30, fontWeight: '700', marginTop: 10, textAlign: 'center' },
  severity: { fontSize: 13, fontWeight: '700', letterSpacing: 1.5, marginTop: 6 },
  message: { fontSize: 19, textAlign: 'center', marginTop: 28, lineHeight: 27 },
  actions: { flexDirection: 'row', justifyContent: 'space-evenly' },
  button: { borderRadius: 999, paddingVertical: 18, paddingHorizontal: 34, minWidth: 140, alignItems: 'center' },
  wide: { alignSelf: 'center', minWidth: 200 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
