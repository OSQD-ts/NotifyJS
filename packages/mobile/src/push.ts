import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
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
  if (!Constants.isDevice) return undefined;

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
