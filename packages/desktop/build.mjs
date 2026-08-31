/**
 * Bundles the three halves of an Electron app.
 *
 * Main and preload run in Node and must not have `electron` bundled into them;
 * the renderer runs in Chromium and must have everything bundled, because the
 * page is loaded from a file with a CSP that forbids anything else.
 */
import { context, build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'dist');
const watch = process.argv.includes('--watch');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
};

const targets = [
  {
    ...common,
    entryPoints: [join(root, 'src/main/index.ts')],
    outfile: join(out, 'main.js'),
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    // `electron` is provided by the runtime. `ws` pulls in two optional native
    // speed-ups that it already require()s inside a try/catch, so leaving them
    // unresolved is the intended behaviour rather than a broken build.
    external: ['electron', 'bufferutil', 'utf-8-validate'],
  },
  {
    ...common,
    entryPoints: [join(root, 'src/preload.ts')],
    outfile: join(out, 'preload.js'),
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
  },
  {
    ...common,
    entryPoints: [join(root, 'src/renderer/index.ts')],
    outfile: join(out, 'renderer.js'),
    platform: 'browser',
    target: 'chrome120',
    format: 'iife',
  },
];

function copyStatic() {
  cpSync(join(root, 'src/renderer/index.html'), join(out, 'index.html'));
  cpSync(join(root, 'src/renderer/styles.css'), join(out, 'styles.css'));

  // Icons are rendered from the repo's single SVG source rather than checked
  // in, so a fresh clone has none until that script has run. Saying so beats
  // an ENOENT from cpSync three frames down.
  const assets = join(root, 'assets');
  if (!existsSync(assets)) {
    throw new Error('packages/desktop/assets is missing - run `npm run icons` in the repo root first');
  }
  cpSync(assets, out, { recursive: true });
}

if (watch) {
  for (const target of targets) {
    const ctx = await context(target);
    await ctx.watch();
  }
  copyStatic();
  console.log('watching for changes');
} else {
  await Promise.all(targets.map((target) => build(target)));
  copyStatic();
  console.log('desktop built ->', out);
}
