import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * The dashboard is plain ES modules served straight off the hub - no bundler.
 * Browsers cannot resolve the bare `@osqd/notifyjs-protocol` specifier that tsc
 * emits, and an inline import map would need a CSP exception, so instead the
 * protocol's build is vendored in and the specifiers rewritten to real paths.
 */
/**
 * `fileURLToPath`, not `.pathname`.
 *
 * A file URL's pathname keeps its leading slash, which on Windows makes
 * `/D:/a/NotifyJS/...` - and joining that onto anything produces
 * `D:\D:\a\NotifyJS\...`, the doubled drive letter this build died on.
 * Every other script here already converts properly; this file was the one
 * that did not, and only the Windows leg of the release ever noticed.
 */
const here = (relative) => fileURLToPath(new URL(relative, import.meta.url));

const dist = here('./dist/');
const vendor = join(dist, 'vendor', 'protocol');

mkdirSync(vendor, { recursive: true });
cpSync(here('../protocol/dist/'), vendor, { recursive: true });
cpSync(here('./public/'), dist, { recursive: true });

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

/**
 * Everything index.html asks the browser to fetch must actually be there.
 *
 * The check below only inspects the .js files it finds, so an empty `dist`
 * passes it vacuously - which is how a build that emitted nothing at all still
 * reported success. `tsc -b` is incremental and skips emitting when it thinks
 * the output is current, so a `dist` deleted without its .tsbuildinfo produces
 * exactly that: no app.js, no error, and a dashboard that 404s on load.
 */
const referenced = [
  ...readFileSync(join(dist, 'index.html'), 'utf8').matchAll(/(?:src|href)="\.\/([^"]+)"/g),
].map((m) => m[1]);

const absent = [...new Set(referenced)].filter((f) => !existsSync(join(dist, f)));
if (absent.length > 0) {
  throw new Error(
    'the dashboard is missing files its own page loads: ' +
      absent.join(', ') +
      '\n  If dist was cleared by hand, remove packages/web/tsconfig.tsbuildinfo too -' +
      '\n  tsc skips emitting when it believes the output is already current.',
  );
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
