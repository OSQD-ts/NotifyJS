import * as SecureStore from 'expo-secure-store';
import type { ClientStorage } from '@osqd/notifyjs-protocol';

/**
 * Credentials live in the iOS Keychain / Android Keystore rather than
 * AsyncStorage: the private seed is what proves this phone's identity to the
 * hub, so it should be no easier to extract than a saved password.
 */
export function secureStorage(): ClientStorage {
  // SecureStore keys must be alphanumeric plus ._-, so dots become underscores.
  const safe = (key: string) => key.replace(/[^A-Za-z0-9._-]/g, '_');

  return {
    async get(key) {
      try {
        return await SecureStore.getItemAsync(safe(key));
      } catch {
        return null;
      }
    },
    async set(key, value) {
      await SecureStore.setItemAsync(safe(key), value, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
    },
    async remove(key) {
      await SecureStore.deleteItemAsync(safe(key));
    },
  };
}

/** Non-secret preferences (hub URL, device name) that survive a reinstall. */
export const PREF_KEYS = {
  url: 'notifyjs_pref_url',
  name: 'notifyjs_pref_name',
} as const;

export async function getPref(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

export async function setPref(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value);
}
