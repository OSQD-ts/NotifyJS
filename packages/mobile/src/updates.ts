import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import Constants from 'expo-constants';
import { checkForUpdate, findAsset, type ReleaseInfo } from '@osqd/notifyjs-protocol';

export const REPOSITORY = 'OSQD-ts/NotifyJS';

export function currentVersion(): string {
  return Constants.expoConfig?.version ?? '0.1.0';
}

export interface AppUpdate {
  release: ReleaseInfo;
  assetUrl: string;
  sizeBytes: number;
}

/**
 * Looks for a newer APK.
 *
 * Returns undefined rather than throwing: a failed check means the phone keeps
 * running the build it has, which is a perfectly good outcome and not worth
 * interrupting anyone over.
 */
export async function findAppUpdate(includePrerelease = false): Promise<AppUpdate | undefined> {
  if (Platform.OS !== 'android') return undefined;

  const result = await checkForUpdate({
    repository: REPOSITORY,
    currentVersion: currentVersion(),
    includePrerelease,
  });
  if (!result.available || !result.latest) return undefined;

  const asset = findAsset(result.latest, /\.apk$/i);
  if (!asset) return undefined;

  return { release: result.latest, assetUrl: asset.url, sizeBytes: asset.size };
}

/**
 * Downloads the APK and hands it to Android's installer.
 *
 * The app cannot install anything itself - it can only ask the system to, and
 * the user confirms. That is the correct shape: an alerting app quietly
 * replacing its own code in the background would be a far worse property than
 * a version being a few days old.
 */
export async function downloadAndInstall(
  update: AppUpdate,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const target = `${FileSystem.cacheDirectory}notifyjs-${update.release.version}.apk`;

  // Remove a partial file from an interrupted attempt; resuming an APK that
  // was truncated would hand the installer a corrupt package.
  await FileSystem.deleteAsync(target, { idempotent: true });

  const download = FileSystem.createDownloadResumable(
    update.assetUrl,
    target,
    {},
    ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
      if (totalBytesExpectedToWrite > 0) {
        onProgress?.(totalBytesWritten / totalBytesExpectedToWrite);
      }
    },
  );

  const result = await download.downloadAsync();
  if (!result?.uri) throw new Error('the download did not complete');

  // A content:// URI, because Android refuses file:// across app boundaries.
  const contentUri = await FileSystem.getContentUriAsync(result.uri);

  await IntentLauncher.startActivityAsync('android.intent.action.INSTALL_PACKAGE', {
    data: contentUri,
    flags: 1, // FLAG_GRANT_READ_URI_PERMISSION, so the installer can read it
    type: 'application/vnd.android.package-archive',
  });
}
