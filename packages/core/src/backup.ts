import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Taking a hub's identity somewhere else.
 *
 * The one thing this project could not survive was losing a directory. The
 * `serverId` is part of every auth signature, so a hub that comes back with a
 * new one is a hub every paired device fails to authenticate against at once -
 * and the only fix is to re-pair every phone by hand. There was no supported
 * way to copy that state to a new machine, and no way to back it up that did
 * not amount to "remember which files matter".
 *
 * Deliberately a file-level operation rather than an admin op over the
 * protocol. A restorable backup has to contain the hub's secrets - the VAPID
 * private key above all - and sending those down a socket to whoever holds an
 * admin credential is a worse bargain than asking an operator to run a command
 * next to the files.
 */

/** Bumped only when the shape changes in a way an older reader would misread. */
export const BACKUP_VERSION = 1;

export interface BackupDocument {
  notifyjs: 'backup';
  version: number;
  createdAt: number;
  /** The `store.json` document, verbatim. */
  store: Record<string, unknown>;
  /** Append-only logs, included only when asked for. */
  history?: string[];
  audit?: string[];
}

const STORE_FILE = 'store.json';
const HISTORY_FILE = 'history.jsonl';
const AUDIT_FILE = 'audit.jsonl';

function readLines(path: string): string[] {
  // Read and handle the absence, rather than asking first and then reading:
  // between the two answers the file can appear or vanish, and the version
  // that asks is the one that throws on the race.
  try {
    return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
}

/**
 * Reads a hub's state off disk.
 *
 * Off *disk*, which means a running hub should be stopped first: it holds the
 * document in memory and writes it on a timer, so exporting underneath one
 * gets whatever was last flushed rather than what is true.
 *
 * History and audit are left out unless asked for: they are the bulk of the
 * bytes and none of the identity, and a backup taken to move a hub to a new
 * machine wants the keys, not last month's alerts.
 */
export function exportStore(
  dir: string,
  options: { history?: boolean } = {},
): BackupDocument {
  const file = join(dir, STORE_FILE);

  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // Worth spelling out: a hub keeps its document in memory and writes it on
    // a timer, so a directory belonging to a hub that has never flushed looks
    // exactly like a directory belonging to no hub at all.
    throw new Error(
      `no store to export at ${file} - if a hub is running here, stop it first so it writes its state out`,
    );
  }

  const store = JSON.parse(raw) as Record<string, unknown>;
  if (!store || typeof store !== 'object' || Array.isArray(store)) {
    throw new Error(`${file} is not a store document`);
  }

  const doc: BackupDocument = {
    notifyjs: 'backup',
    version: BACKUP_VERSION,
    createdAt: Date.now(),
    store,
  };
  if (options.history) {
    doc.history = readLines(join(dir, HISTORY_FILE));
    doc.audit = readLines(join(dir, AUDIT_FILE));
  }
  return doc;
}

/** Whether a parsed document is one of ours, and one we can read. */
export function isBackup(value: unknown): value is BackupDocument {
  if (!value || typeof value !== 'object') return false;
  const doc = value as Partial<BackupDocument>;
  return (
    doc.notifyjs === 'backup' &&
    typeof doc.version === 'number' &&
    !!doc.store &&
    typeof doc.store === 'object'
  );
}

/**
 * Writes a hub's state back to disk.
 *
 * Refuses an occupied directory unless told otherwise, because the failure it
 * prevents is unrecoverable: restoring over a live hub's store replaces the
 * `serverId` and the device keys, and every phone paired against the old one
 * stops authenticating with no way back. The caller is expected to have
 * stopped the hub first - a running one holds this document in memory and
 * would write straight back over anything put here.
 *
 * Files are written 0600. They contain the VAPID private key and the hashes of
 * every credential the hub issued.
 */
export function importStore(
  dir: string,
  doc: BackupDocument,
  options: { force?: boolean } = {},
): { restoredHistory: number; restoredAudit: number } {
  if (!isBackup(doc)) throw new Error('not a NotifyJS backup');
  if (doc.version > BACKUP_VERSION) {
    throw new Error(
      `this backup is version ${doc.version}; this build reads up to ${BACKUP_VERSION}`,
    );
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, STORE_FILE);

  // `wx` fails if the file is already there, which is the same refusal as
  // asking first - except it cannot be raced. Asking and then writing leaves a
  // window in which the store appears between the two, and the guard that
  // exists to stop an accidental overwrite quietly does not.
  try {
    writeFileSync(file, JSON.stringify(doc.store), {
      mode: 0o600,
      flag: options.force ? 'w' : 'wx',
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    throw new Error(`${file} already exists; pass --force to replace it`);
  }

  // Only when the backup carried them. A restore that silently emptied an
  // existing history would be a second, quieter kind of data loss.
  let restoredHistory = 0;
  let restoredAudit = 0;
  if (doc.history) {
    writeFileSync(join(dir, HISTORY_FILE), doc.history.map((l) => l + '\n').join(''), {
      mode: 0o600,
    });
    restoredHistory = doc.history.length;
  }
  if (doc.audit) {
    writeFileSync(join(dir, AUDIT_FILE), doc.audit.map((l) => l + '\n').join(''), { mode: 0o600 });
    restoredAudit = doc.audit.length;
  }

  return { restoredHistory, restoredAudit };
}

/** What an operator should be told before they hand this file to anybody. */
export function backupSecrets(doc: BackupDocument): string[] {
  const store = doc.store as { vapid?: unknown; ingestTokens?: Record<string, unknown> };
  const secrets: string[] = [];
  if (store.vapid) secrets.push('the VAPID private key browsers are subscribed against');
  if (store.ingestTokens && Object.keys(store.ingestTokens).length > 0) {
    secrets.push('hashes of every HTTP publishing token');
  }
  secrets.push('this hub’s serverId, which every device signs against');
  return secrets;
}
