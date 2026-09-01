/**
 * Stamps one version across every manifest that carries one, and rewrites the
 * dependencies between the publishable packages to match.
 *
 * This is the part that makes a monorepo publishable at all: `@osqd/notifyjs`
 * depends on `@osqd/notifyjs-protocol`, and if that dependency still says
 * `0.1.0` while the tarball being published is `0.1.0-main.7`, npm installs a
 * version that does not exist yet - or worse, an older one that does.
 *
 * It also covers the manifests nothing publishes but people still read: the
 * desktop app's version is what it reports to a hub and shows in its settings,
 * and the mobile app's is the `versionName` inside the APK. Both used to sit
 * at whatever was committed, so every release since 0.1.0 shipped an app
 * claiming to be 0.1.0.
 *
 *   node scripts/set-version.mjs 0.2.0
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Dependency order: each package is published after everything it needs.
 *
 * The release workflow publishes in this order too. Only these are published,
 * so only these pin each other.
 */
export const PACKAGES = ['protocol', 'web', 'core', 'cli'];

/**
 * Manifests that carry a version but are never published.
 *
 * The root is private and its version is what a source checkout falls back to
 * when nothing has stamped a build. The two apps are private because they ship
 * as installers and an APK rather than as tarballs, which does not make their
 * version any less visible to the people running them.
 */
export const PRIVATE_MANIFESTS = ['package.json', 'packages/desktop/package.json', 'packages/mobile/package.json'];

/** Expo reads the Android `versionName` and `versionCode` out of this. */
export const EXPO_MANIFEST = 'packages/mobile/app.json';

const version = process.argv[2]?.replace(/^v/, '');
if (isEntryPoint()) {
  if (!version) {
    console.error('usage: set-version.mjs <version>');
    process.exit(1);
  }
  setVersion(version);
}

/**
 * Whether this file was run directly, rather than imported.
 *
 * Compared as resolved paths. The obvious form - `import.meta.url ===
 * \`file://${process.argv[1]}\`` - is a URL against a filesystem path, and the
 * two stop matching the moment the checkout sits anywhere needing percent
 * encoding: a directory with a space in it makes this read false, the script
 * exits 0 having changed nothing, and the release publishes packages whose
 * dependencies on each other name a version that was never published. Silent,
 * and precisely the failure this file exists to prevent.
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  const resolve = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
}

/**
 * Android's own version number, which has to be an ever-increasing integer and
 * has nothing to do with semver.
 *
 * A thousand each for minor and patch: 0.1.0 is 1000, 0.2.0 is 2000, 1.0.0 is
 * 1000000, and the ordering matches semver's for every version this project
 * will plausibly reach. Android's ceiling is 2100000000, which this passes at
 * major 2100.
 *
 * It matters because a device refuses to install an APK whose versionCode is
 * not higher than the one already there. Left at Expo's default of 1 forever,
 * every release after the first is an APK the phone declines to upgrade to.
 */
export function versionCode(target) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(target);
  if (!m) throw new Error(`'${target}' has no version to derive a versionCode from`);
  const [, major, minor, patch] = m.map(Number);
  return major * 1_000_000 + minor * 1_000 + patch;
}

export function setVersion(target) {
  const published = new Set(
    PACKAGES.map((pkg) => manifestPath(pkg))
      .filter((path) => existsSync(path))
      .map((path) => JSON.parse(readFileSync(path, 'utf8')).name),
  );

  for (const pkg of PACKAGES) stamp(manifestPath(pkg), target, published);
  for (const rel of PRIVATE_MANIFESTS) stamp(join(root, rel), target, published);
  stampExpo(join(root, EXPO_MANIFEST), target);
}

/**
 * One package.json: its own version, and any sibling it depends on.
 *
 * Missing files are skipped rather than fatal. Not every caller has the whole
 * tree - the regression test for this runs it against a directory holding only
 * the publishable manifests - and a version stamp is not the place to start
 * enforcing what a checkout must contain.
 */
function stamp(path, target, published) {
  if (!existsSync(path)) return;
  const json = JSON.parse(readFileSync(path, 'utf8'));
  json.version = target;

  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = json[field];
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (!published.has(name)) continue;
      // A `file:` link is how the two private apps resolve the protocol
      // package from the checkout they are built in. Rewriting one to a
      // version number points it at a tarball on a registry that, during a
      // release, has not been published yet - and the app fails to build.
      if (typeof spec === 'string' && spec.startsWith('file:')) continue;
      // Everything else is pinned exactly: these are built and published
      // together, and a range would let an install mix versions that were
      // never tested as a set.
      deps[name] = target;
    }
  }

  writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
  console.log(`  ${(json.name ?? path).padEnd(26)} ${target}`);
}

/** app.json, whose version lives under `expo` and needs a versionCode beside it. */
function stampExpo(path, target) {
  if (!existsSync(path)) return;
  const json = JSON.parse(readFileSync(path, 'utf8'));
  if (!json.expo) return;
  json.expo.version = target;
  json.expo.android = { ...json.expo.android, versionCode: versionCode(target) };
  writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
  console.log(`  ${'expo (app.json)'.padEnd(26)} ${target}  versionCode ${json.expo.android.versionCode}`);
}

function manifestPath(pkg) {
  return join(root, 'packages', pkg, 'package.json');
}
