import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import type { ClientStorage } from '@osqd/notifyjs-protocol';

/**
 * File-backed credential storage for the CLI.
 *
 * The file holds this device's Ed25519 private seed, so it is created 0600 in
 * a 0700 directory. Losing it costs nothing but a re-pair; leaking it lets
 * someone impersonate this device until it is revoked.
 */
export function fileStorage(path = defaultPath()): ClientStorage {
  const load = (): Record<string, string> => {
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  };

  const save = (data: Record<string, string>): void => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
    // `mode` above only applies when the file is created. Restated on every
    // write so a file that already existed - restored from a backup, copied
    // between machines, written by an older build - does not keep permissions
    // that let another local account read this device's private seed.
    tighten(path);
  };

  return {
    async get(key) {
      return load()[key] ?? null;
    },
    async set(key, value) {
      const data = load();
      data[key] = value;
      save(data);
    },
    async remove(key) {
      const data = load();
      delete data[key];
      save(data);
    },
  };
}

export function defaultPath(): string {
  return join(homedir(), '.notifyjs', 'credentials.json');
}

/** Restates 0600 on an existing file; a no-op where modes are meaningless. */
function tighten(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    /* a filesystem without POSIX modes, or a file we do not own */
  }
}
