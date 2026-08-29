/**
 * Packages a built bundle into a release archive for one platform.
 *
 * Each archive contains the executable plus the `dashboard` directory beside
 * it, which is where the hub looks when it cannot resolve the web package as a
 * module. Run after scripts/bundle.mjs.
 *
 *   node scripts/package.mjs --target node20-linux-x64 --name notifyjs-linux-x64
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    name: { type: 'string' },
    format: { type: 'string', default: 'tar.gz' },
  },
});

if (!values.target || !values.name) {
  throw new Error('usage: package.mjs --target <pkg-target> --name <asset-name> [--format tar.gz|zip]');
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(root, 'build');
const staging = join(build, 'staging', 'notifyjs');
const isWindows = values.target.includes('win');
const exeName = isWindows ? 'notifyjs.exe' : 'notifyjs';

if (!existsSync(join(build, 'notifyjs.cjs'))) {
  throw new Error('bundle missing - run scripts/bundle.mjs first');
}

rmSync(join(build, 'staging'), { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });

run('npx', [
  'pkg',
  join(build, 'notifyjs.cjs'),
  '--targets',
  values.target,
  '--output',
  join(staging, exeName),
]);

if (!isWindows) chmodSync(join(staging, exeName), 0o755);

cpSync(join(build, 'dashboard'), join(staging, 'dashboard'), { recursive: true });
cpSync(join(build, 'service'), join(staging, 'service'), { recursive: true });
cpSync(join(build, 'README.txt'), join(staging, 'README.txt'));

const outDir = join(build, 'artifacts');
mkdirSync(outDir, { recursive: true });
const stagingParent = join(build, 'staging');

if (values.format === 'zip') {
  run('zip', ['-r', '-q', join(outDir, `${values.name}.zip`), 'notifyjs'], stagingParent);
  console.log(`packaged -> ${values.name}.zip`);
} else {
  run('tar', ['czf', join(outDir, `${values.name}.tar.gz`), 'notifyjs'], stagingParent);
  console.log(`packaged -> ${values.name}.tar.gz`);
}
