import { requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export interface IncomingCallOptions {
  id: string;
  from: string;
  message: string;
  severity?: string;
}

interface NotifyjsCallNative {
  showIncomingCall(options: IncomingCallOptions): void;
  dismissCall(id: string): void;
  showAlert(id: string, title: string, body: string): void;
  canUseFullScreen(): boolean;
  openFullScreenSettings(): void;
  startWatching(hubName: string): void;
  stopWatching(): void;
}

/**
 * Android-only native support for alerts that arrive when the app is not on
 * screen.
 *
 * Two problems it solves, both invisible from JavaScript. A React Native screen
 * cannot draw over a locked phone - only a notification with a full-screen
 * intent can. And once the app leaves the screen Android reclaims its process,
 * taking the WebSocket with it, so nothing arrives at all until you open the
 * app again.
 *
 * On platforms without an implementation every method is a no-op, so callers do
 * not need to branch.
 */
const native: NotifyjsCallNative | undefined =
  Platform.OS === 'android' ? requireNativeModule('NotifyjsCall') : undefined;

/** Rings like a phone call, over the lock screen. */
export function showIncomingCall(options: IncomingCallOptions): void {
  native?.showIncomingCall(options);
}

export function dismissCall(id: string): void {
  native?.dismissCall(id);
}

/** Posts an ordinary alert without relying on a JS timer being alive. */
export function showAlert(id: string, title: string, body: string): void {
  native?.showAlert(id, title, body);
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

export const isSupported = native !== undefined;
