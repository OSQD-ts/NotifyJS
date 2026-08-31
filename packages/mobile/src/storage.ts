import * as SecureStore from 'expo-secure-store';
import type { ClientStorage } from '@osqd/notifyjs-protocol';

/**
 * Credentials live in the iOS Keychain / Android Keystore rather than
 * AsyncStorage: the private seed is what proves this phone's identity to the
 * hub, so it should be no easier to extract than a saved password.
 */
export function secureStorage(): ClientStorage {
  // SecureStore keys are limited to alphanumerics plus `.`, `_` and `-`;
  // anything else in a key becomes an underscore.
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
