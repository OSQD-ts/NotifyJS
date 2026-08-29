import { cpSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The dashboard is plain ES modules served straight off the hub - no bundler.
 * Browsers cannot resolve the bare `@notifyjs/protocol` specifier that tsc
 * emits, and an inline import map would need a CSP exception, so instead the
 * protocol's build is vendored in and the specifiers rewritten to real paths.
 */
const dist = new URL('./dist/', import.meta.url).pathname;
const vendor = join(dist, 'vendor', 'protocol');

mkdirSync(vendor, { recursive: true });
cpSync(new URL('../protocol/dist/', import.meta.url).pathname, vendor, { recursive: true });
cpSync(new URL('./public/', import.meta.url).pathname, dist, { recursive: true });

const REWRITES = [
  [/(['"])@notifyjs\/protocol\/web\1/g, "'./vendor/protocol/crypto-web.js'"],
  [/(['"])@notifyjs\/protocol\1/g, "'./vendor/protocol/index.js'"],
];

for (const file of readdirSync(dist)) {
  if (!file.endsWith('.js')) continue;
  const path = join(dist, file);
  let code = readFileSync(path, 'utf8');
  for (const [pattern, replacement] of REWRITES) code = code.replace(pattern, replacement);
  writeFileSync(path, code);
}

console.log('dashboard built ->', dist);
