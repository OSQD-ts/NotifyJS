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
  canUseFullScreen(): boolean;
  openFullScreenSettings(): void;
}

/**
 * Android-only native call UI.
 *
 * A JavaScript screen cannot appear over a locked phone; only a notification
 * with a full-screen intent can. This module raises one, which Android turns
 * into the same takeover a phone call gets - screen on, over the keyguard,
 * with Answer and Decline.
 *
 * On platforms without an implementation every method is a no-op, so callers
 * do not need to branch: the in-app call screen still handles those.
 */
const native: NotifyjsCallNative | undefined =
  Platform.OS === 'android' ? requireNativeModule('NotifyjsCall') : undefined;

export function showIncomingCall(options: IncomingCallOptions): void {
  native?.showIncomingCall(options);
}

export function dismissCall(id: string): void {
  native?.dismissCall(id);
}

/** False when Android would downgrade the call to an ordinary notification. */
export function canUseFullScreen(): boolean {
  return native?.canUseFullScreen() ?? false;
}

/** Opens the settings page where the user can grant full-screen alerts. */
export function openFullScreenSettings(): void {
  native?.openFullScreenSettings();
}

export const isSupported = native !== undefined;
