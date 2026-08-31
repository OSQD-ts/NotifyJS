import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import Constants from 'expo-constants';
import { sha256 } from '@noble/hashes/sha256';
import {
  CHECKSUM_ASSET,
  checkForUpdate,
  findAsset,
  findChecksum,
  fromBase64Url,
  type ReleaseAsset,
  type ReleaseInfo,
} from '@osqd/notifyjs-protocol';

export const REPOSITORY = 'OSQD-ts/NotifyJS';

export function currentVersion(): string {
  return Constants.expoConfig?.version ?? '0.1.0';
}

export interface AppUpdate {
  release: ReleaseInfo;
  assetUrl: string;
  assetName: string;
  sizeBytes: number;
  /** The release's checksum listing, without which nothing is installed. */
  checksumUrl: string;
}

/** Nothing this project ships comes close; the cap is a runaway guard. */
const MAX_APK_BYTES = 300 * 1024 * 1024;

/** Read back in pieces so a large APK is never held in memory all at once. */
const HASH_CHUNK_BYTES = 1024 * 1024;

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
  if (asset.size > MAX_APK_BYTES) return undefined;

  // A release with no checksum listing is not offered at all. Surfacing an
  // update the phone would then refuse to install is worse than staying quiet.
  const sums = result.latest.assets.find((a: ReleaseAsset) => a.name === CHECKSUM_ASSET);
  if (!sums) return undefined;

  return {
    release: result.latest,
    assetUrl: asset.url,
    assetName: asset.name,
    sizeBytes: asset.size,
    checksumUrl: sums.url,
  };
}

/**
 * Downloads the APK, verifies it, and hands it to Android's installer.
 *
 * The app cannot install anything itself - it can only ask the system to, and
 * the user confirms. That is the correct shape: an alerting app quietly
 * replacing its own code in the background would be a far worse property than
 * a version being a few days old.
 *
 * What the user confirms still has to be the bytes this release published.
 * Android verifies the APK's own signature, which stops an unrelated package
 * from installing over this one, but it says nothing about *which* build of
 * ours arrived - so the release's own SHA-256 is checked first, exactly as the
 * CLI does before replacing its binary. A file that does not match is deleted
 * rather than offered to the installer.
 */
export async function downloadAndInstall(
  update: AppUpdate,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const target = `${FileSystem.cacheDirectory}notifyjs-${update.release.version}.apk`;

  // Fetched before the download, so a release whose checksums cannot be read
  // costs nothing rather than a whole APK transfer.
  const expected = await fetchExpectedDigest(update);

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

  try {
    await verifyDownload(result.uri, expected);
  } catch (err) {
    // A file that failed verification must not be left where a later attempt,
    // or anything else on the device, could pick it up.
    await FileSystem.deleteAsync(target, { idempotent: true });
    throw err;
  }

  // A content:// URI, because Android refuses file:// across app boundaries.
  const contentUri = await FileSystem.getContentUriAsync(result.uri);

  await IntentLauncher.startActivityAsync('android.intent.action.INSTALL_PACKAGE', {
    data: contentUri,
    flags: 1, // FLAG_GRANT_READ_URI_PERMISSION, so the installer can read it
    type: 'application/vnd.android.package-archive',
  });
}

/**
 * How long any single update request may hang before it is given up on.
 *
 * `AbortController` with a timer rather than `AbortSignal.timeout`, which is
 * not present on every React Native runtime this ships to.
 */
const UPDATE_REQUEST_TIMEOUT_MS = 60_000;

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchExpectedDigest(update: AppUpdate): Promise<string> {
  // Bounded like the CLI's equivalent. This is the step that decides whether an
  // APK is safe to install, and a connection that stalls rather than fails
  // leaves the update screen spinning with no way forward.
  const response = await fetchWithTimeout(update.checksumUrl);
  if (!response.ok) {
    throw new Error(`could not read the release checksums (HTTP ${response.status})`);
  }
  const expected = findChecksum(await response.text(), update.assetName);
  if (!expected) {
    throw new Error(`this release publishes no checksum for ${update.assetName}`);
  }
  return expected;
}

/** Hashes the downloaded file in chunks and compares it with the release. */
async function verifyDownload(uri: string, expected: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(uri, { size: true });
  if (!info.exists) throw new Error('the download went missing before it could be checked');

  const size = info.size ?? 0;
  if (size === 0 || size > MAX_APK_BYTES) {
    throw new Error('the download is not a plausible size; refusing to install');
  }

  const hash = sha256.create();
  for (let position = 0; position < size; position += HASH_CHUNK_BYTES) {
    const chunk = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
      position,
      length: Math.min(HASH_CHUNK_BYTES, size - position),
    });
    hash.update(fromBase64Url(chunk));
  }

  const actual = toHex(hash.digest());
  if (actual !== expected) {
    throw new Error('the download does not match the published checksum; refusing to install');
  }
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
