/**
 * Installs the built app for the current user, with no root and no terminal
 * afterwards.
 *
 * The .deb is the better answer on a Debian-derived desktop, but it needs
 * sudo. This puts the same application in the same menu using only paths the
 * user already owns, which is enough for a machine you are the only person on.
 * Everything it writes lives under ~/.local, and `--uninstall` takes it all
 * back out.
 *
 *   node scripts/install-local.mjs [--uninstall]
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = homedir();

const APP_ID = 'notifyjs-desktop';
const binDir = join(home, '.local', 'bin');
const appPath = join(binDir, 'NotifyJS.AppImage');
const desktopDir = join(home, '.local', 'share', 'applications');
const desktopFile = join(desktopDir, `${APP_ID}.desktop`);
const iconDir = join(home, '.local', 'share', 'icons', 'hicolor', '512x512', 'apps');
const iconFile = join(iconDir, `${APP_ID}.png`);

if (process.argv.includes('--uninstall')) {
  for (const path of [appPath, desktopFile, iconFile]) rmSync(path, { force: true });
  refresh();
  console.log('removed. Paired hubs are kept in ~/.config/NotifyJS - delete that too for a clean slate.');
  process.exit(0);
}

/**
 * The AppImage carries its own Electron, so one file is the whole install.
 *
 * `npm run dist:linux` builds both architectures into the same directory, so
 * pick the one this machine can run rather than whichever readdir happens to
 * return first: an arm64 AppImage on an x64 desktop fails with `Exec format
 * error` long after the menu entry has been written, which looks like a broken
 * app rather than a wrong download.
 */
const release = join(root, 'release');
const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
const images = existsSync(release)
  ? readdirSync(release).filter((f) => f.endsWith('.AppImage'))
  : [];
// A single image is taken at its word: `npm run dist` builds only for the host,
// and older builds carry the architecture nowhere in the name.
const built = images.find((f) => f.includes(arch)) ?? (images.length === 1 ? images[0] : undefined);
if (!built) {
  throw new Error(
    images.length
      ? `no ${arch} AppImage in release/ - found ${images.join(', ')}`
      : 'no AppImage in release/ - run `npm run dist` first',
  );
}

mkdirSync(binDir, { recursive: true });
mkdirSync(desktopDir, { recursive: true });
mkdirSync(iconDir, { recursive: true });

copyFileSync(join(release, built), appPath);
chmodSync(appPath, 0o755);
copyFileSync(join(root, 'assets', 'icon.png'), iconFile);

/**
 * `StartupWMClass` has to match the `app_id` Electron sets from `desktopName`
 * in the app's package.json - `notifyjs-desktop.desktop` minus the suffix, and
 * so the same as APP_ID - or the running window shows up as a second, nameless
 * icon instead of lighting up this launcher. The .deb electron-builder
 * produces names its entry from the same field, so both installs agree.
 *
 * The "Start hidden" action exists because this is a tray app somebody may
 * want at login without a window in their face.
 */
writeFileSync(
  desktopFile,
  `[Desktop Entry]
Type=Application
Name=NotifyJS
GenericName=Alert client
Comment=Self-hosted alerts and spoken calls from your own hubs
Exec=${appPath} %U
Icon=${APP_ID}
Terminal=false
Categories=Utility;
Keywords=alerts;notifications;oncall;monitoring;
StartupWMClass=${APP_ID}
StartupNotify=true
Actions=Hidden;

[Desktop Action Hidden]
Name=Start in the tray
Exec=${appPath} --hidden
`,
  { mode: 0o644 },
);

refresh();
console.log(`installed for ${process.env.USER ?? 'this user'}:
  ${appPath}
  ${desktopFile}
  ${iconFile}

Look for "NotifyJS" in the applications menu. Undo with:
  node scripts/install-local.mjs --uninstall`);

/** Best effort: the menu usually notices on its own, and never fails for this. */
function refresh() {
  execFile('update-desktop-database', [desktopDir], () => {});
  execFile('gtk-update-icon-cache', ['-f', '-t', join(home, '.local', 'share', 'icons', 'hicolor')], () => {});
}
