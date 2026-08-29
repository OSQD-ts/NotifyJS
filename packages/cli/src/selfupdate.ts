import { createHash } from 'node:crypto';
import {
  chmodSync,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { checkForUpdate, findAsset, type ReleaseInfo, type UpdateCheck } from '@osqd/notifyjs-protocol';

/** Matches this machine to the asset built for it. */
export function assetPattern(): RegExp {
  const os = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return new RegExp(`notifyjs-${os}-${arch}\\.(tar\\.gz|zip)$`);
}

export interface UpdateOptions {
  repository: string;
  currentVersion: string;
  includePrerelease?: boolean;
  currentBuiltAt?: number;
}

export async function check(options: UpdateOptions): Promise<UpdateCheck> {
  return checkForUpdate({
    repository: options.repository,
    currentVersion: options.currentVersion,
    includePrerelease: options.includePrerelease ?? false,
    currentBuiltAt: options.currentBuiltAt,
  });
}

export interface ApplyResult {
  version: string;
  installedAt: string;
  backup: string;
}

/**
 * Replaces the running executable with a newer one.
 *
 * Two things make this safe enough to do unattended. The download is checked
 * against the release's own SHA256SUMS before anything is touched, so a
 * truncated or tampered archive never reaches the filesystem. And the swap is
 * a rename, which is atomic on the same filesystem - there is no moment where
 * the binary is half-written.
 *
 * The previous binary is kept alongside, because the most likely thing to go
 * wrong with an update is the new version, not the download.
 */
export async function apply(
  release: ReleaseInfo,
  options: { targetPath?: string } = {},
): Promise<ApplyResult> {
  const target = options.targetPath ?? process.execPath;
  const asset = findAsset(release, assetPattern());
  if (!asset) {
    throw new Error(`release ${release.tag} has no build for ${process.platform}/${process.arch}`);
  }

  // Refuse rather than fail obscurely partway through.
  assertWritable(target);

  const work = mkdtempSync(join(tmpdir(), 'notifyjs-update-'));
  try {
    const archive = join(work, asset.name);
    await download(asset.url, archive);
    await verifyChecksum(release, asset.name, archive);

    const extracted = join(work, 'unpacked');
    await extract(archive, extracted);

    const binaryName = process.platform === 'win32' ? 'notifyjs.exe' : 'notifyjs';
    const fresh = join(extracted, 'notifyjs', binaryName);
    statSync(fresh); // throws with a clear message if the layout changed
    chmodSync(fresh, 0o755);

    // Keep the old one: rolling back should not require another download.
    const backup = `${target}.previous`;
    renameSync(target, backup);
    try {
      renameSync(fresh, target);
    } catch (err) {
      // Cross-device rename fails; put the original back rather than leaving
      // the machine with no binary at all.
      renameSync(backup, target);
      throw err;
    }

    return { version: release.version, installedAt: target, backup };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function assertWritable(target: string): void {
  try {
    statSync(target);
    statSync(dirname(target));
  } catch {
    throw new Error(`cannot find ${target} to replace`);
  }
  // A packaged binary reports itself as execPath; running from `node` would
  // otherwise try to overwrite the Node installation.
  if (/\bnode(\.exe)?$/.test(target)) {
    throw new Error(
      'this looks like a source checkout run under node, not a packaged binary - update with git instead',
    );
  }
}

async function download(url: string, to: string): Promise<void> {
  const response = await fetch(url, {
    headers: { accept: 'application/octet-stream' },
    redirect: 'follow',
  });
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(to));
}

/**
 * Checks the archive against SHA256SUMS.txt from the same release.
 *
 * This is the difference between an updater and a remote code execution
 * primitive: without it, anything able to answer the download request could
 * replace the binary.
 */
async function verifyChecksum(release: ReleaseInfo, name: string, path: string): Promise<void> {
  const sums = release.assets.find((a) => a.name === 'SHA256SUMS.txt');
  if (!sums) throw new Error(`release ${release.tag} publishes no checksums; refusing to update`);

  const listing = await (await fetch(sums.url, { redirect: 'follow' })).text();
  const line = listing.split('\n').find((l) => l.trim().endsWith(name));
  const expected = line?.trim().split(/\s+/)[0];
  if (!expected) throw new Error(`no checksum published for ${name}; refusing to update`);

  const actual = createHash('sha256').update(await readFile(path)).digest('hex');
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${name}: refusing to install`);
  }
}

function extract(archive: string, into: string): Promise<void> {
  const isZip = archive.endsWith('.zip');
  const args = isZip ? ['-q', archive, '-d', into] : ['xzf', archive, '-C', into];
  const command = isZip ? 'unzip' : 'tar';

  return new Promise((resolve, reject) => {
    mkdirSync(into, { recursive: true });
    execFile(command, args, (err) =>
      err ? reject(new Error(`could not unpack ${archive}: ${err.message}`)) : resolve(),
    );
  });
}
