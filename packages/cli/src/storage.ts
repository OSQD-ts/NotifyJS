import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
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
    // Read and parse are kept apart, because only one of them means the file is
    // broken. A read can fail for reasons that may well pass - permissions, a
    // file owned by another account, too many open files, a transient I/O error -
    // and moving the file aside for one of those would cause exactly the loss this
    // guard exists to prevent.
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      say(`notifyjs: ${path} could not be read (${(err as Error).message})`);
      return {};
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // The damaged file is kept, not read past. Returning `{}` here made this
      // device look unpaired against *every* hub, and the next `set()` - the
      // re-pair that follows naturally - wrote a file containing only the new
      // key, destroying the private seeds for all the others. The comment on
      // `save()` promises the opposite: a keypair cannot be regenerated. So the
      // evidence is moved aside first, exactly as the hub's own store does with a
      // corrupt `store.json`.
      return setAside('it could not be parsed');
    }
    // `JSON.parse('null')` succeeds and yields null, which then threw on every
    // read; an array or a number is no more usable.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return setAside('it did not contain an object');
    }
    return parsed as Record<string, string>;
  };

  /**
   * Says something where somebody might see it.
   *
   * Wrapped, because a packaged GUI app may have no stderr at all and writing to
   * one that fails would throw out of `load()` - turning every credential read
   * into a rejected promise. `console.error` as well, since that is what reaches
   * an Electron main process's log.
   */
  const say = (line: string): void => {
    try {
      process.stderr.write(`${line}\n`);
    } catch {
      /* no stderr: a packaged windowed application */
    }
    try {
      console.error(line);
    } catch {
      /* nothing to write to at all */
    }
  };

  /** Renames a file that cannot be used, and says where it went. */
  const setAside = (why: string): Record<string, string> => {
    const kept = `${path}.corrupt-${Date.now()}`;
    try {
      renameSync(path, kept);
      say(
        `notifyjs: ${path} was ignored because ${why}; it has been kept at ${kept}. ` +
          'This device will need pairing again, and the old file still holds its keys.',
      );
    } catch {
      say(`notifyjs: ${path} cannot be used (${why}) and could not be moved aside`);
    }
    return {};
  };

  const save = (data: Record<string, string>): void => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Write-then-rename, exactly as the hub's own store does: a crash or power
    // loss partway through a direct write leaves a truncated file, `load()`
    // cannot parse it, and this device silently loses the private seed that is
    // its identity - appearing unpaired while the hub still holds its record.
    // History can be regenerated; a keypair cannot.
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
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
