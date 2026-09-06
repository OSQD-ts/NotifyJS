import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';

/**
 * Obtains a wake-up token for this device.
 *
 * A socket only lives while the app does, so without this a phone hears
 * nothing once the app is swiped away. Registering is the user's choice: the
 * hub ignores tokens unless push is enabled there too, and enabling it means
 * alert titles travel through Expo and then Apple or Google.
 */
export async function getPushToken(): Promise<string | undefined> {
  // Emulators and simulators cannot receive push at all.
  //
  // `Device.isDevice`, not `Constants.isDevice`: expo-constants removed that
  // property in SDK 50, and its `NativeConstants` carries an `[key: string]:
  // any` index signature, so reading it still typechecks and simply evaluates
  // to `undefined`. Every real phone therefore looked like a simulator and
  // took the early return, which left the hub with no token to push to.
  if (!Device.isDevice) return undefined;

  try {
    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== 'granted') {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== 'granted') return undefined;

    if (Platform.OS === 'android') {
      // Android needs a channel before anything can be shown, and the alert
      // channel should be allowed to interrupt.
      await Notifications.setNotificationChannelAsync('alerts', {
        name: 'Alerts',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 400, 200, 400],
        sound: 'default',
      });
    }

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;

    const token = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    return token.data;
  } catch {
    // No push is a degraded experience, not a failure worth blocking on.
    return undefined;
  }
}

/**
 * Takes down the wake-up push for an alert the app has now handled itself.
 *
 * The hub pushes to a device it believes is not reading its socket and sends
 * the alert down that socket regardless, so a phone that was asleep gets both:
 * the push that woke it, and - once its JavaScript is running again - the real
 * notification posted from the feed. Two notifications, one incident. The push
 * carries the notification's id in its payload, which is what lets the second
 * one replace the first rather than pile up beside it.
 */
export async function dismissPushFor(notificationId: string): Promise<void> {
  try {
    for (const presented of await Notifications.getPresentedNotificationsAsync()) {
      const data = presented.request.content.data as { id?: unknown } | undefined;
      if (data?.id === notificationId) {
        await Notifications.dismissNotificationAsync(presented.request.identifier);
      }
    }
  } catch {
    // Leaving a duplicate on screen is not worth failing an alert over.
  }
}
