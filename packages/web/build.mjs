import { cpSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The dashboard is plain ES modules served straight off the hub - no bundler.
 * Browsers cannot resolve the bare `@osqd/notifyjs-protocol` specifier that tsc
 * emits, and an inline import map would need a CSP exception, so instead the
 * protocol's build is vendored in and the specifiers rewritten to real paths.
 */
const dist = new URL('./dist/', import.meta.url).pathname;
const vendor = join(dist, 'vendor', 'protocol');

mkdirSync(vendor, { recursive: true });
cpSync(new URL('../protocol/dist/', import.meta.url).pathname, vendor, { recursive: true });
cpSync(new URL('./public/', import.meta.url).pathname, dist, { recursive: true });

/**
 * Keyed on the package's real name. These went stale once when the package was
 * renamed, and nothing noticed: the rewrite silently matched nothing, the build
 * reported success, and the dashboard shipped with a bare specifier no browser
 * can resolve. The assertion below is why that cannot happen twice.
 */
const PACKAGE = '@osqd/notifyjs-protocol';
const REWRITES = [
  [new RegExp(`(['"])${escapeRe(PACKAGE)}/web\\1`, 'g'), "'./vendor/protocol/crypto-web.js'"],
  [new RegExp(`(['"])${escapeRe(PACKAGE)}\\1`, 'g'), "'./vendor/protocol/index.js'"],
];

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

/**
 * Anything a browser would have to resolve itself. `./`, `../` and `/` are
 * real paths; everything else is a bare specifier and would fail at load.
 */
const BARE_IMPORT =
  /(?:^|\s)(?:import|export)\b[^'"]*?from\s*(['"])(?![./])([^'"]+)\1|(?:^|\s)import\s*(['"])(?![./])([^'"]+)\3/gm;

const unresolved = [];

for (const file of readdirSync(dist)) {
  if (!file.endsWith('.js')) continue;
  const path = join(dist, file);
  let code = readFileSync(path, 'utf8');
  for (const [pattern, replacement] of REWRITES) code = code.replace(pattern, replacement);
  writeFileSync(path, code);

  for (const match of code.matchAll(BARE_IMPORT)) {
    unresolved.push(`${file}: ${match[2] ?? match[4]}`);
  }
}

// A bare specifier here is not a warning: the page throws on load and the
// dashboard does not come up at all. Better to fail the build than ship it.
if (unresolved.length > 0) {
  throw new Error(
    'dashboard has imports a browser cannot resolve; add them to REWRITES:\n  ' +
      unresolved.join('\n  '),
  );
}

console.log('dashboard built ->', dist);
