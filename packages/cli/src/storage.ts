import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
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
