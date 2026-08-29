/**
 * Renders every icon the apps need from the two SVG sources.
 *
 * Kept as a script rather than checked-in-only PNGs so the artwork has a
 * single source of truth: change `assets/icon.svg` and re-run, instead of
 * hand-editing six bitmaps and hoping they stay consistent.
 *
 *   node scripts/render-icons.mjs
 */
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'assets');
const mobile = join(root, 'packages/mobile/assets');
const web = join(root, 'packages/web/public');

mkdirSync(mobile, { recursive: true });

/** Places a glyph on a transparent canvas at a fraction of its width. */
async function inset(svg, size, scale, background = { r: 0, g: 0, b: 0, alpha: 0 }) {
  const glyph = await sharp(svg)
    .resize(Math.round(size * scale), Math.round(size * scale))
    .png()
    .toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([{ input: glyph, gravity: 'centre' }])
    .png()
    .toBuffer();
}

const jobs = [
  // The launcher icon, full bleed. iOS applies its own rounding.
  ['icon.png', () => sharp(join(src, 'icon.svg')).resize(1024, 1024).png().toBuffer()],

  // Android adaptive foreground. The outer ~33% can be cropped by any launcher
  // mask, so the bell only occupies the safe centre.
  ['adaptive-icon.png', () => inset(join(src, 'icon-mono.svg'), 1024, 0.62)],

  // Splash: the same glyph on the app's own dark background, so there is no
  // colour flash between the splash and the first screen.
  ['splash.png', () => inset(join(src, 'icon-mono.svg'), 1024, 0.34)],

  // Android status bar. The system keeps only the alpha channel and tints it.
  ['notification-icon.png', () => inset(join(src, 'icon-mono.svg'), 96, 0.86)],

  ['favicon.png', () => sharp(join(src, 'icon.svg')).resize(196, 196).png().toBuffer()],
];

for (const [name, render] of jobs) {
  const buffer = await render();
  await sharp(buffer).toFile(join(mobile, name));
  const { width, height } = await sharp(buffer).metadata();
  console.log(`  ${name.padEnd(24)} ${width}x${height}`);
}

// The dashboard serves its own favicon, so it gets the vector directly.
await sharp(join(src, 'icon.svg')).resize(196, 196).png().toFile(join(web, 'favicon.png'));
const { copyFileSync } = await import('node:fs');
copyFileSync(join(src, 'icon.svg'), join(web, 'icon.svg'));
console.log('  dashboard favicon.png + icon.svg');
