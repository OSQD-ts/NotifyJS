/**
 * Stamps one version across every publishable package, and rewrites the
 * dependencies between them to match.
 *
 * This is the part that makes a monorepo publishable at all: `@osqd/notifyjs`
 * depends on `@osqd/notifyjs-protocol`, and if that dependency still says
 * `0.1.0` while the tarball being published is `0.1.0-main.7`, npm installs a
 * version that does not exist yet - or worse, an older one that does.
 *
 *   node scripts/set-version.mjs 0.2.0
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Dependency order: each package is published after everything it needs. */
export const PACKAGES = ['protocol', 'web', 'core', 'cli'];

const version = process.argv[2]?.replace(/^v/, '');
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!version) {
    console.error('usage: set-version.mjs <version>');
    process.exit(1);
  }
  setVersion(version);
}

export function setVersion(target) {
  const names = new Set(
    PACKAGES.map((p) => JSON.parse(readFileSync(manifest(p), 'utf8')).name),
  );

  for (const pkg of PACKAGES) {
    const path = manifest(pkg);
    const json = JSON.parse(readFileSync(path, 'utf8'));
    json.version = target;

    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const deps = json[field];
      if (!deps) continue;
      for (const name of Object.keys(deps)) {
        // Pin exactly: these are built and published together, and a range
        // would let an install mix versions that were never tested as a set.
        if (names.has(name)) deps[name] = target;
      }
    }

    writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
    console.log(`  ${json.name.padEnd(26)} ${target}`);
  }
}

function manifest(pkg) {
  return join(root, 'packages', pkg, 'package.json');
}
