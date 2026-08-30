import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ClientStorage } from '@osqd/notifyjs-protocol';

/**
 * File-backed credential storage.
 *
 * The same shape as the CLI's, deliberately re-implemented here rather than
 * imported: `@osqd/notifyjs-cli` also carries the hub, and a desktop *client*
 * has no business shipping a server it can never run.
 *
 * The file holds one Ed25519 private seed per paired hub, so it is written
 * 0600 inside a 0700 directory. Losing it costs a re-pair; leaking it lets
 * someone impersonate this computer until it is revoked.
 */
export function fileStorage(path: string): ClientStorage {
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
