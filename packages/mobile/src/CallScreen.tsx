import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, Vibration, View } from 'react-native';
import * as Speech from 'expo-speech';
import * as Haptics from 'expo-haptics';
import { useKeepAwake } from 'expo-keep-awake';
import type { CallRequest } from '@osqd/notifyjs-protocol';
import { isSupported, speakCall, stopRinging, stopSpeaking } from '../modules/notifyjs-call';
import { SEVERITY_COLORS, useTheme } from './theme';

interface Props {
  call: CallRequest;
  /** The listener's own speech settings, which win over the call's defaults. */
  speech: { enabled: boolean; rate: number; pitch: number; lang: string; repeat: number };
  /** True when the call was answered from the notification, before this screen existed. */
  answered?: boolean;
  onAnswer(): void;
  onDecline(): void;
  onFinished(): void;
}

/** Ring cadence for platforms without the native ringer. */
const RING_PATTERN = [0, 700, 800, 700, 1600];

/**
 * The incoming-call screen.
 *
 * On Android the ringing and the spoken message are native: both have to work
 * on a phone whose ringer is off and whose JS thread the system has stopped
 * scheduling, and neither `Vibration` nor `expo-speech` can promise that.
 * This screen is then the visible half of a call the OS is already conducting.
 * Elsewhere it falls back to doing both itself.
 */
export function CallScreen({ call, speech, answered, onAnswer, onDecline, onFinished }: Props) {
  const t = useTheme();
  const [speaking, setSpeaking] = useState(false);
  useKeepAwake();

  // Ring until the user acts. Android is already ringing natively by the time
  // this mounts; anywhere else the buzz is all there is.
  useEffect(() => {
    if (isSupported || speaking) return;
    Vibration.vibrate(RING_PATTERN, true);
    return () => Vibration.cancel();
  }, [speaking]);

  useEffect(() => {
    return () => {
      Vibration.cancel();
      stopRinging();
      stopSpeaking();
      Speech.stop();
    };
  }, []);

  /** Guards against answering twice - from the notification and from the screen. */
  const started = useRef(false);

  const answer = () => {
    if (started.current) return;
    started.current = true;

    Vibration.cancel();
    stopRinging();
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSpeaking(true);
    onAnswer();

    if (!speech.enabled) {
      // Answering still counts; the person simply does not want it read out.
      onFinished();
      return;
    }

    const options = {
      lang: speech.lang || call.lang || 'en-US',
      rate: speech.rate || call.rate || 1,
      pitch: speech.pitch || call.pitch || 1,
      repeat: Math.max(1, Math.min(speech.repeat || call.repeat || 1, 5)),
    };

    if (isSupported) {
      // Resolves on failure too, so a broken speech engine still closes the
      // call rather than stranding the screen with no way back to the feed.
      void speakCall(call.message, options).then(onFinished, onFinished);
      return;
    }

    let spoken = 0;
    const speakOnce = () => {
      Speech.speak(call.message, {
        language: options.lang,
        rate: options.rate,
        pitch: options.pitch,
        onDone: () => (++spoken < options.repeat ? speakOnce() : onFinished()),
        onError: onFinished,
        onStopped: onFinished,
      });
    };
    speakOnce();
  };

  // Answering from the notification happens before this screen exists, so the
  // call arrives already answered and goes straight to speaking.
  useEffect(() => {
    if (answered) answer();
  }, [answered]);

  const decline = () => {
    Vibration.cancel();
    stopRinging();
    stopSpeaking();
    Speech.stop();
    onDecline();
  };

  const hangUp = () => {
    stopSpeaking();
    Speech.stop();
    onFinished();
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
        <TouchableOpacity onPress={hangUp} style={[styles.button, styles.wide, { backgroundColor: '#ff6b6b' }]}>
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
