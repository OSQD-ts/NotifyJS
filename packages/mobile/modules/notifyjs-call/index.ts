import { EventEmitter, requireNativeModule, type Subscription } from 'expo-modules-core';
import { Platform } from 'react-native';

export interface IncomingCallOptions {
  id: string;
  from: string;
  message: string;
  severity?: string;
}

/** Answer or Decline tapped on the notification rather than in the app. */
export interface CallAction {
  action: 'answer' | 'decline';
  callId: string;
}

/**
 * Why the app was asked to look at its connection.
 *
 * `alarm` is the periodic heartbeat, `network` a connection that has just come
 * back. Carried for logging and for nothing else - both mean the same thing to
 * the client, which is to resync.
 */
export interface WakeEvent {
  reason: 'alarm' | 'network';
}

interface NotifyjsCallNative {
  showIncomingCall(options: IncomingCallOptions): void;
  dismissCall(id: string): void;
  stopRinging(): void;
  speak(text: string, language: string, rate: number, pitch: number, repeat: number): Promise<boolean>;
  stopSpeaking(): void;
  showAlert(id: string, title: string, body: string, sound: boolean, vibrate: boolean): void;
  canUseFullScreen(): boolean;
  openFullScreenSettings(): void;
  isBatteryOptimized(): boolean;
  openBatterySettings(): void;
  startWatching(hubName: string): void;
  stopWatching(): void;
  consumeAnsweredCall(): string | null;
}

/**
 * Android-only native support for alerts that arrive when the app is not on
 * screen.
 *
 * Three problems it solves, all invisible from JavaScript. A React Native
 * screen cannot draw over a locked phone - only a notification with a
 * full-screen intent can. Once the app leaves the screen Android reclaims its
 * process, taking the WebSocket with it, so nothing arrives at all until you
 * open the app again. And a call whose sound comes from a notification channel
 * is silenced by the same switch that silences a text message, which is not
 * what anybody means by a call.
 *
 * On platforms without an implementation every method is a no-op, so callers do
 * not need to branch.
 */
const native: NotifyjsCallNative | undefined =
  Platform.OS === 'android' ? requireNativeModule('NotifyjsCall') : undefined;

const emitter = native ? new EventEmitter(native as never) : undefined;

/**
 * Rings like a phone call, over the lock screen.
 *
 * The ringing is native and runs on the alarm stream, so it survives a silent
 * phone, Do Not Disturb, and a JS thread the OS has stopped scheduling.
 */
export function showIncomingCall(options: IncomingCallOptions): void {
  native?.showIncomingCall(options);
}

/** Ends the call: stops the ring and takes the notification down. */
export function dismissCall(id: string): void {
  native?.dismissCall(id);
}

/** Answering. The notification stays until the message has been spoken. */
export function stopRinging(): void {
  native?.stopRinging();
}

/**
 * Speaks an answered call's message.
 *
 * Native rather than `expo-speech` because Android's default speech attributes
 * put the utterance on the music stream, where a muted phone plays it to
 * nobody. Resolves once there is nothing more to say - including on failure,
 * so a caller can always close the call screen.
 */
export function speakCall(
  text: string,
  { lang = '', rate = 1, pitch = 1, repeat = 1 }: { lang?: string; rate?: number; pitch?: number; repeat?: number } = {},
): Promise<boolean> {
  return native?.speak(text, lang, rate, pitch, repeat) ?? Promise.resolve(false);
}

export function stopSpeaking(): void {
  native?.stopSpeaking();
}

/**
 * Answer or Decline pressed on the notification itself.
 *
 * Actions taken before this listener existed are replayed on subscribe, since
 * tapping Answer on a lock screen is often what starts the app in the first
 * place.
 */
export function addCallActionListener(listener: (event: CallAction) => void): Subscription | undefined {
  return emitter?.addListener<CallAction>('onCallAction', listener);
}

/**
 * The call answered by the notification that launched this app, if any.
 * Reading it clears it, so a later return to the app does not re-answer.
 */
export function consumeAnsweredCall(): string | undefined {
  return native?.consumeAnsweredCall() ?? undefined;
}

/**
 * Posts an ordinary alert without relying on a JS timer being alive.
 *
 * Uses the default notification tone, never the ringtone - that belongs to
 * calls. `sound` and `vibrate` select between channels, because Android fixes
 * a channel's behaviour at creation and will not let it be changed later.
 */
export function showAlert(
  id: string,
  title: string,
  body: string,
  { sound = true, vibrate = true }: { sound?: boolean; vibrate?: boolean } = {},
): void {
  native?.showAlert(id, title, body, sound, vibrate);
}

/** False when Android would downgrade a call to an ordinary notification. */
export function canUseFullScreen(): boolean {
  return native?.canUseFullScreen() ?? false;
}

/** Opens the settings page where the user can grant full-screen alerts. */
export function openFullScreenSettings(): void {
  native?.openFullScreenSettings();
}

/**
 * True when Android is free to suspend this app's network while the screen is
 * off - the usual reason an alert arrives hours late, or only once the phone
 * is picked up.
 */
export function isBatteryOptimized(): boolean {
  return native?.isBatteryOptimized() ?? false;
}

/** Opens the battery-optimisation list, where the app can be excused from it. */
export function openBatterySettings(): void {
  native?.openBatterySettings();
}

/**
 * Keeps the connection alive while the app is off screen, at the cost of a
 * permanent low-priority notification. Without it, closing the app silently
 * stops every alert.
 */
export function startWatching(hubName: string): void {
  native?.startWatching(hubName);
}

export function stopWatching(): void {
  native?.stopWatching();
}

/**
 * Fires when the app should check whether its connection still works.
 *
 * The client recovers a dead socket perfectly well on its own, but every one
 * of its mechanisms for noticing is a JavaScript timer, and those are measured
 * against a clock Android stops advancing while the phone dozes. So the socket
 * dies overnight, the keepalive that would have caught it never runs, and the
 * backlog only arrives when somebody picks the phone up.
 *
 * This is the missing input: an alarm that Doze still releases, and a callback
 * for the network coming back. Neither carries any content - the alert itself
 * still comes over the hub connection, which is the only thing that knows what
 * was missed.
 */
export function addWakeListener(listener: (event: WakeEvent) => void): Subscription | undefined {
  return emitter?.addListener<WakeEvent>('onWake', listener);
}

export const isSupported = native !== undefined;
