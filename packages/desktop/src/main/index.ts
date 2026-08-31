import { app, BrowserWindow, ipcMain, Menu, Notification, nativeImage, Tray, shell } from 'electron';
import { join } from 'node:path';
import { Hub } from './hub.js';
import { speakSystem } from './speech.js';
import type { ActiveCall, AddSourceInput, AppState, ClientPreferences, DesktopPreferences } from '../shared.js';

const VERSION = app.getVersion();

/**
 * A second copy would open a second set of sockets to every hub, and the two
 * would race to acknowledge the same alerts. The instance already running is
 * asked to show itself instead.
 */
if (!app.requestSingleInstanceLock()) app.exit(0);

let hub: Hub;
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
/** Set only by an explicit Quit, so closing the window can mean "hide". */
let quitting = false;

function send(channel: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

/* ------------------------------- window ----------------------------- */

function createWindow(show: boolean): BrowserWindow {
  const win = new BrowserWindow({
    width: 460,
    height: 760,
    minWidth: 380,
    minHeight: 520,
    show,
    // The phone app is a dark, self-contained panel; matching it here also
    // avoids a white flash before the renderer's own styles land.
    backgroundColor: '#0e1116',
    autoHideMenuBar: true,
    icon: join(__dirname, 'icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // A hidden window must keep ringing and speaking. Chromium otherwise
      // throttles timers and audio in a window nobody is looking at, which is
      // exactly the window a call arrives in.
      backgroundThrottling: false,
    },
  });

  win.loadFile(join(__dirname, 'index.html'));

  // Closing means "get out of the way", not "stop listening" - the whole point
  // of a tray client. Quit is deliberate, from the tray or the menu.
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });

  // Alerts routinely carry links to a dashboard or a runbook. Opening them in
  // the app would turn an alerting client into an unsandboxed browser - and
  // handing an arbitrary scheme to the OS is worse still, since `file:` and
  // the handlers a machine happens to have registered are reachable that way.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalWebUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // The window only ever shows its own bundled page. Anything that tries to
  // navigate it somewhere else is a bug or an attack, never a feature.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  return win;
}

/** Only ordinary web links are worth handing to the operating system. */
function isExternalWebUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow(true);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/* -------------------------------- tray ------------------------------ */

function trayIcon() {
  const icon = nativeImage.createFromPath(join(__dirname, 'tray.png'));
  // macOS wants a template image so the icon inverts with the menu bar.
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  return icon.isEmpty() ? undefined : icon;
}

function buildTrayMenu(state: AppState): void {
  if (!tray) return;
  const connected = state.sources.filter((s) => s.enabled && s.status === 'ready').length;
  const enabled = state.sources.filter((s) => s.enabled).length;
  const snoozing = state.snoozedUntil > Date.now();

  tray.setToolTip(
    state.sources.length === 0 ? 'NotifyJS - no sources' : `NotifyJS - ${connected}/${enabled} connected`,
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `${connected}/${enabled} hubs connected`, enabled: false },
      { type: 'separator' },
      { label: 'Open NotifyJS', click: showWindow },
      {
        label: snoozing ? 'Resume alerts' : 'Snooze for 30 minutes',
        click: () => hub.setSnooze(snoozing ? 0 : 30 * 60_000),
      },
      {
        label: 'Start at login',
        type: 'checkbox',
        checked: state.desktop.launchAtLogin,
        click: (item) => applyDesktopPrefs({ launchAtLogin: item.checked }),
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

/* ------------------------------ delivery ---------------------------- */

/**
 * A system notification for an ordinary alert.
 *
 * Electron's own notification is used rather than shelling out to
 * `notify-send`/`osascript`: it is one code path across the three platforms,
 * and clicking it can bring the window up, which a spawned command cannot.
 */
function notify(title: string, body: string, silent: boolean): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent });
  n.on('click', showWindow);
  n.show();
}

/**
 * A call is the one thing allowed to interrupt.
 *
 * The phone takes over the lock screen for this; the desktop equivalent is to
 * raise the window in front of whatever is there. `setAlwaysOnTop` is dropped
 * again a moment later - a window that stays pinned forever is a window people
 * uninstall.
 */
function announceCall(call: ActiveCall, raise: boolean): void {
  // Always announced, even when the window is told to stay put: somebody who
  // turned off "bring the window forward" still wants to know it is ringing.
  notify(`Incoming call · ${call.sourceLabel}`, call.call.message, true);
  if (!raise) return;

  showWindow();
  if (!mainWindow) return;
  mainWindow.setAlwaysOnTop(true, 'pop-up-menu');
  mainWindow.flashFrame(true);
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false);
  }, 1500);
}

function applyDesktopPrefs(patch: Partial<DesktopPreferences>): void {
  hub.saveDesktopPrefs(patch);
  const desktop = hub.snapshot().desktop;
  // Re-applied whenever either half changes: turning on "start hidden" after
  // "start at login" has to rewrite the arguments the login item passes, or
  // the setting silently does nothing until the other one is toggled.
  if (patch.launchAtLogin !== undefined || patch.startHidden !== undefined) {
    // Linux support varies by desktop environment; Electron writes an autostart
    // entry where it can and no-ops where it cannot.
    app.setLoginItemSettings({
      openAtLogin: desktop.launchAtLogin,
      args: desktop.startHidden ? ['--hidden'] : [],
    });
  }
}

/* --------------------------------- IPC ------------------------------ */

function registerIpc(): void {
  ipcMain.handle('state', () => hub.snapshot());

  ipcMain.handle('source:add', async (_e, input: AddSourceInput) => {
    try {
      await hub.addSource(input);
      return { ok: true as const };
    } catch (err) {
      // Pairing fails for ordinary reasons - a typo, a hub that moved - and the
      // renderer needs the message, not a thrown IPC rejection.
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('source:remove', (_e, id: string) => hub.removeSource(id));
  ipcMain.handle('source:enabled', (_e, id: string, enabled: boolean) =>
    hub.setSourceEnabled(id, enabled),
  );

  ipcMain.handle('prefs:save', (_e, patch: Partial<ClientPreferences>) => hub.savePrefs(patch));
  ipcMain.handle('prefs:desktop', (_e, patch: Partial<DesktopPreferences>) =>
    applyDesktopPrefs(patch),
  );

  ipcMain.handle('call:answer', () => hub.answerCall());
  ipcMain.handle('call:decline', () => hub.declineCall());
  ipcMain.handle('call:end', () => hub.endCall());
  ipcMain.handle('call:speak', (_e, message: string, repeat: number) =>
    speakSystem(message, repeat),
  );

  ipcMain.handle('feed:clear', () => hub.clearFeed());
  ipcMain.handle('snooze', (_e, durationMs: number) => hub.setSnooze(durationMs));
  ipcMain.handle('sync', () => hub.sync());
  ipcMain.on('window:hide', () => mainWindow?.hide());
  ipcMain.on('quit', () => {
    quitting = true;
    app.quit();
  });
}

/* ------------------------------ lifecycle --------------------------- */

app.on('second-instance', showWindow);

app.whenReady().then(async () => {
  hub = new Hub(app.getPath('userData'), VERSION);

  hub.on('state', (state) => {
    send('state', state);
    buildTrayMenu(state);
  });

  hub.on('alert', ({ notification, sourceLabel }) => {
    notify(
      `${notification.severity.toUpperCase()}: ${notification.title}`,
      notification.body ?? `${sourceLabel} · ${notification.channel}`,
      !hub.snapshot().prefs.sound,
    );
  });

  hub.on('call', (call) => {
    send('call', call);
    if (call) announceCall(call, hub.snapshot().desktop.raiseOnCall);
  });

  registerIpc();

  const icon = trayIcon();
  if (icon) {
    tray = new Tray(icon);
    tray.on('click', showWindow);
  }

  // `--hidden` is what the login item passes, so starting with the machine
  // does not throw a window at somebody who is trying to log in.
  const hidden = hub.snapshot().desktop.startHidden || process.argv.includes('--hidden');
  mainWindow = createWindow(!hidden);

  await hub.start();
  buildTrayMenu(hub.snapshot());
});

// Deliberately not quitting when the last window closes: on every platform
// this app's job continues without one.
app.on('window-all-closed', () => {});

app.on('activate', showWindow);

app.on('before-quit', () => {
  quitting = true;
  hub?.stop();
});
