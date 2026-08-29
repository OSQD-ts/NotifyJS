/**
 * Bundles the CLI into a single CommonJS file for packaging into a native
 * executable.
 *
 * The executable packagers (pkg, Node SEA) both want one CJS entry with no
 * module graph to resolve at runtime, which is also why the hub can no longer
 * find the dashboard via `require.resolve` and looks beside the executable
 * instead.
 */
import { build } from 'esbuild';
import { mkdirSync, cpSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build');

// cpSync only adds files, so a stale dashboard from a previous build would
// otherwise survive the filter below.
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Releases are cut from a git tag, so the tag - not the checked-in
// package.json - is the authority on what version this artifact is.
const { version: manifestVersion } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = process.env.NOTIFYJS_VERSION?.replace(/^v/, '') || manifestVersion;

await build({
  entryPoints: [join(root, 'packages/cli/dist/bin.js')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: join(out, 'notifyjs.cjs'),
  // No shebang banner here: esbuild preserves the one already on bin.ts, and
  // a second copy on line 2 is a syntax error that silently defeats pkg's
  // bytecode step - producing a binary whose entry point is missing.
  define: {
    'process.env.NOTIFYJS_VERSION': JSON.stringify(version),
    // Lets the updater reason about the rolling build, which carries a moving
    // tag rather than a version.
    'process.env.NOTIFYJS_BUILT_AT': JSON.stringify(String(Date.now())),
  },
  // ws loads these native speedups opportunistically inside a try/catch; they
  // are optional and must not be pulled into the bundle.
  external: ['bufferutil', 'utf-8-validate'],
  legalComments: 'none',
  minify: false,
});

// The dashboard travels beside the binary rather than inside it, so the
// released archive is a directory the hub can serve straight out of. Type
// declarations and source maps are build-time artifacts no browser requests,
// and they roughly double the archive if left in.
const SHIPPED = /\.(html|css|js|json|svg|png|ico|webmanifest)$/;
cpSync(join(root, 'packages/web/dist'), join(out, 'dashboard'), {
  recursive: true,
  filter: (src, dest) => {
    if (src.endsWith('.d.ts') || src.endsWith('.map')) return false;
    // Directories carry no extension and must always be recursed into.
    return SHIPPED.test(src) || !/\.[a-z0-9]+$/i.test(src);
  },
});

// Service definitions travel with the binary so "run it as a service" is a
// copy away rather than something the operator has to write from scratch.
cpSync(join(root, 'packaging'), join(out, 'service'), { recursive: true });
cpSync(join(root, 'LICENSE'), join(out, 'LICENSE'));

writeFileSync(
  join(out, 'README.txt'),
  `NotifyJS ${version}

Run the hub:

    ./notifyjs serve --port 7741

Then open http://localhost:7741 and pair a device with the printed code.

The "dashboard" directory next to this binary holds the web UI. Keep them
together, or point elsewhere with --dashboard-dir.

Run it as a service:

    Linux   see service/notifyjs.service
    macOS   see service/dev.notifyjs.plist

Turn on TLS (recommended before exposing the port):

    ./notifyjs cert
    ./notifyjs serve --tls-cert .notifyjs/notifyjs-cert.pem --tls-key .notifyjs/notifyjs-key.pem

Licensed under the OSQD Non-Resale License 1.0 - see LICENSE.

Full docs: https://github.com/${process.env.GITHUB_REPOSITORY ?? 'your/notifyjs'}
`,
);

console.log('bundled ->', join(out, 'notifyjs.cjs'));
