import {
  NotifyClient,
  SEVERITIES,
  defaultPreferences,
  isPairingCodeValid,
  normalizePreferences,
  severityRank,
  webStorage,
  type CallRequest,
  type ClientPreferences,
  type Device,
  type Notification,
  type Severity,
} from '@notifyjs/protocol';
import { webCrypto } from '@notifyjs/protocol/web';
import { Ringer, speak, stopSpeaking } from './speech.js';
import {
  announcementFor,
  formatCodeInput,
  matchesFilter,
  qrDataUrl,
  renderNotificationItem,
} from './view.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** The dashboard connects back to whichever hub served it. */
const HUB_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

const client = new NotifyClient({
  url: HUB_URL,
  crypto: webCrypto,
  storage: webStorage(),
  createSocket: (url) => new WebSocket(url) as never,
  deviceName: loadPreferences().deviceName,
  platform: 'web',
  model: navigator.userAgent.slice(0, 60),
  autoReconnect: true,
  // A browser that is itself offline must not claim the service is down.
  isOnline: () => navigator.onLine,
});

const ringer = new Ringer();
const feed: Notification[] = [];
let activeFilter: Severity | 'all' = 'all';
let activeCall: CallRequest | undefined;

/* ---------------------------------------------------------------- */
/* Settings                                                          */
/* ---------------------------------------------------------------- */

const PREFS_KEY = 'notifyjs.preferences';

/**
 * What this browser wants, as opposed to what its role permits. Applied on
 * top of the hub's filtering, so it can only ever narrow the feed.
 */
let prefs: ClientPreferences = loadPreferences();

function loadPreferences(): ClientPreferences {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return normalizePreferences(raw ? JSON.parse(raw) : null, 'Browser');
  } catch {
    // Unreadable settings must not stop the dashboard from loading.
    return defaultPreferences('Browser');
  }
}

function savePreferences(patch: Partial<ClientPreferences>): void {
  prefs = normalizePreferences({ ...prefs, ...patch }, prefs.deviceName);
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Private browsing: the settings apply for this session regardless.
  }
  renderSettings();
  renderFeed();
}

function renderSettings(): void {
  $<HTMLInputElement>('pref-name').value = prefs.deviceName;
  $<HTMLSelectElement>('pref-severity').value = prefs.minSeverity;
  $<HTMLInputElement>('pref-sound').checked = prefs.sound;
  $<HTMLInputElement>('pref-desktop').checked =
    'Notification' in window && Notification.permission === 'granted';
  $<HTMLInputElement>('pref-speech').checked = prefs.speech.enabled;
  $<HTMLInputElement>('pref-rate').value = String(prefs.speech.rate);
  $('pref-rate-value').textContent = `${prefs.speech.rate.toFixed(1)}x`;
  $<HTMLInputElement>('pref-repeat').value = String(prefs.speech.repeat);
  $('pref-repeat-value').textContent = `${prefs.speech.repeat}x`;
  $('settings-hub').textContent = `${client.serverName ?? 'NotifyJS'} at ${location.host}`;
}

function wireSettings(): void {
  const severity = $<HTMLSelectElement>('pref-severity');
  severity.replaceChildren(
    ...SEVERITIES.map((s) => {
      const option = document.createElement('option');
      option.value = s;
      option.textContent = s;
      return option;
    }),
  );

  $('settings-toggle').addEventListener('click', () => {
    renderSettings();
    $('settings').hidden = false;
  });
  $('settings-close').addEventListener('click', () => ($('settings').hidden = true));

  $('pref-name').addEventListener('change', (e) =>
    savePreferences({ deviceName: (e.target as HTMLInputElement).value }),
  );
  severity.addEventListener('change', (e) =>
    savePreferences({ minSeverity: (e.target as HTMLSelectElement).value as Severity }),
  );
  $('pref-sound').addEventListener('change', (e) =>
    savePreferences({ sound: (e.target as HTMLInputElement).checked }),
  );
  $('pref-speech').addEventListener('change', (e) =>
    savePreferences({ speech: { ...prefs.speech, enabled: (e.target as HTMLInputElement).checked } }),
  );
  $('pref-rate').addEventListener('input', (e) =>
    savePreferences({ speech: { ...prefs.speech, rate: Number((e.target as HTMLInputElement).value) } }),
  );
  $('pref-repeat').addEventListener('input', (e) =>
    savePreferences({ speech: { ...prefs.speech, repeat: Number((e.target as HTMLInputElement).value) } }),
  );

  // Permission can only be requested from a gesture, so it lives here rather
  // than being toggled programmatically.
  $('pref-desktop').addEventListener('change', async () => {
    await ringer.unlock();
    await Notification.requestPermission();
    renderSettings();
    updateNotificationButton();
  });

  $('pref-forget').addEventListener('click', async () => {
    client.disconnect();
    await client.forgetCredentials();
    location.reload();
  });
}

/* ---------------------------------------------------------------- */
/* Pairing                                                           */
/* ---------------------------------------------------------------- */

function showPairing(message?: string): void {
  $('pair').hidden = false;
  $('app').hidden = true;
  const err = $<HTMLParagraphElement>('pair-error');
  err.hidden = !message;
  if (message) err.textContent = message;
  $<HTMLButtonElement>('pair-submit').disabled = false;
}

function showApp(): void {
  $('pair').hidden = true;
  $('app').hidden = false;
}

$('pair-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('code');
  const name = $<HTMLInputElement>('device-name').value.trim();

  // Validating the checksum locally means a typo never reaches the hub, so it
  // cannot count against the pairing rate limit or trip a lockout.
  if (!isPairingCodeValid(input.value)) {
    showPairing('That code is not valid. Check for a typo and try again.');
    return;
  }
  if (name) savePreferences({ deviceName: name });

  $<HTMLButtonElement>('pair-submit').disabled = true;
  $('pair-error').hidden = true;
  // Audio unlock has to ride on this click; there may be no other gesture
  // before the first call arrives.
  void ringer.unlock();
  void client.pair(input.value);
});

$('code').addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement;
  el.value = formatCodeInput(el.value);
});

/* ---------------------------------------------------------------- */
/* Feed                                                              */
/* ---------------------------------------------------------------- */

function buildFilters(): void {
  const wrap = $('filters');
  const options: (Severity | 'all')[] = ['all', ...SEVERITIES];
  wrap.replaceChildren(
    ...options.map((value) => {
      const b = document.createElement('button');
      b.textContent = value;
      b.setAttribute('aria-pressed', String(value === activeFilter));
      b.addEventListener('click', () => {
        activeFilter = value;
        buildFilters();
        renderFeed();
      });
      return b;
    }),
  );
}

function renderFeed(): void {
  const list = $('feed');
  const visible = feed
    .filter((n) => severityRank(n.severity) >= severityRank(prefs.minSeverity))
    .filter((n) => matchesFilter(n, activeFilter));
  $('empty').hidden = visible.length > 0;
  list.replaceChildren(
    ...visible.map((n) =>
      renderNotificationItem(n, {
        onAction: (notification, actionId) =>
          client.ack([notification.id], { seq: notification.seq, action: actionId }),
      }),
    ),
  );
}

/** Speaks one line into the live region rather than re-reading the feed. */
function announce(text: string): void {
  $('announcer').textContent = text;
}

$('clear').addEventListener('click', () => {
  feed.length = 0;
  renderFeed();
});

/* ---------------------------------------------------------------- */
/* Desktop notifications                                             */
/* ---------------------------------------------------------------- */

function updateNotificationButton(): void {
  const btn = $<HTMLButtonElement>('enable-notifications');
  btn.hidden = !('Notification' in window) || Notification.permission !== 'default';
}

$('enable-notifications').addEventListener('click', async () => {
  await ringer.unlock();
  await Notification.requestPermission();
  updateNotificationButton();
});

function popNotification(n: Notification): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return;
  new Notification(`${n.severity.toUpperCase()}: ${n.title}`, {
    body: n.body ?? n.channel,
    tag: n.id,
  });
}

/* ---------------------------------------------------------------- */
/* Calls                                                             */
/* ---------------------------------------------------------------- */

/** Restores focus to wherever it was before the call took over the screen. */
let focusBeforeCall: HTMLElement | null = null;

function openCall(call: CallRequest): void {
  activeCall = call;
  focusBeforeCall = document.activeElement as HTMLElement | null;
  $('call-from').textContent = call.from;
  $('call-severity').textContent = call.severity;
  $('call-message').textContent = call.message;
  $('call-speaking').hidden = true;
  $<HTMLElement>('call-decline').hidden = false;
  $<HTMLElement>('call-answer').hidden = false;
  const screen = $('call');
  screen.hidden = false;
  screen.dataset.ringing = 'true';
  // A ringing phone takes over the screen; a screen reader should be told
  // immediately rather than waiting its turn behind the feed.
  announce(`Incoming alert from ${call.from}. ${call.message}`);
  $<HTMLButtonElement>('call-answer').focus();
  if (prefs.sound) ringer.start();
}

function closeCall(): void {
  activeCall = undefined;
  ringer.stop();
  stopSpeaking();
  const screen = $('call');
  screen.hidden = true;
  screen.dataset.ringing = 'false';
  focusBeforeCall?.focus();
  focusBeforeCall = null;
}

/**
 * Keeps focus inside the call while it is up, and lets Escape decline.
 * Without this, tabbing wanders into the feed behind an overlay that is
 * visually covering the whole screen.
 */
document.addEventListener('keydown', (e) => {
  if (!activeCall || $('call').hidden) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    $<HTMLButtonElement>('call-decline').click();
    return;
  }
  if (e.key !== 'Tab') return;

  const focusable = [...$('call').querySelectorAll<HTMLButtonElement>('button')].filter(
    (b) => !b.hidden,
  );
  if (focusable.length === 0) return;

  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

$('call-answer').addEventListener('click', async () => {
  const call = activeCall;
  if (!call) return;
  client.answerCall(call.id);
  ringer.stop();
  $('call-answer').hidden = true;
  $('call-decline').hidden = true;
  $('call-speaking').hidden = false;

  if (prefs.speech.enabled) {
    await speak({
      ...call,
      rate: prefs.speech.rate,
      pitch: prefs.speech.pitch,
      repeat: prefs.speech.repeat,
      lang: prefs.speech.lang || call.lang,
    });
  }
  client.endCall(call.id);
  closeCall();
});

$('call-decline').addEventListener('click', () => {
  if (activeCall) client.declineCall(activeCall.id);
  closeCall();
});

/* ---------------------------------------------------------------- */
/* Devices drawer                                                    */
/* ---------------------------------------------------------------- */

function canManage(): boolean {
  return client.capabilities.includes('admin') || client.capabilities.includes('devices.manage');
}

async function refreshDevices(): Promise<void> {
  if (!canManage()) return;
  const data = await client.admin<{ devices: Device[]; online: string[] }>('devices.list');
  const online = new Set(data.online);
  $('device-list').replaceChildren(
    ...data.devices.map((device) => {
      const li = document.createElement('li');
      li.className = 'device';

      const top = document.createElement('div');
      top.className = 'device-top';

      const dot = document.createElement('span');
      dot.className = online.has(device.id) ? 'dot online' : 'dot';

      const name = document.createElement('span');
      name.className = 'device-name';
      name.textContent = device.name;

      const revoke = document.createElement('button');
      revoke.className = 'revoke';
      revoke.textContent = device.status === 'revoked' ? 'revoked' : 'Revoke';
      revoke.disabled = device.status === 'revoked';
      revoke.addEventListener('click', async () => {
        await client.admin('devices.revoke', { deviceId: device.id });
        await refreshDevices();
      });

      top.append(dot, name, revoke);

      const meta = document.createElement('div');
      meta.className = 'muted small';
      meta.textContent = `${device.role} · ${device.platform}`;

      li.append(top, meta);
      return li;
    }),
  );
}

async function refreshRoles(): Promise<void> {
  const data = await client.admin<{ roles: { name: string }[] }>('roles.list');
  const select = $<HTMLSelectElement>('code-role');
  select.replaceChildren(
    ...data.roles.map((role) => {
      const opt = document.createElement('option');
      opt.value = role.name;
      opt.textContent = role.name;
      return opt;
    }),
  );
  select.value = 'viewer';
}

$('devices-toggle').addEventListener('click', async () => {
  $('devices').hidden = false;
  await Promise.all([refreshDevices(), refreshRoles()]);
});

$('devices-close').addEventListener('click', () => {
  $('devices').hidden = true;
});

$('new-code').addEventListener('click', async () => {
  const role = $<HTMLSelectElement>('code-role').value || 'viewer';
  const issued = await client.admin<{
    code: string;
    qr?: { svg: string };
  }>('pair.create', { role });

  $('code-value').textContent = issued.code;

  const qr = $<HTMLImageElement>('code-qr');
  if (issued.qr) {
    // A data: URL rather than innerHTML: the page never parses hub-supplied
    // markup, and `img-src 'self' data:` already permits this under the CSP.
    qr.src = qrDataUrl(issued.qr.svg);
    qr.hidden = false;
  } else {
    qr.hidden = true;
  }
  $('new-code-out').hidden = false;
});

/* ---------------------------------------------------------------- */
/* Wiring                                                            */
/* ---------------------------------------------------------------- */

client.on('status', (status) => {
  const el = $('status');
  el.textContent = status;
  el.dataset.state = status;
  if (status === 'unpaired') showPairing();
});

client.on('ready', (ready) => {
  showApp();
  $('hub-name').textContent = client.serverName ?? 'NotifyJS';
  $('device-line').textContent = `${ready.deviceName} · ${ready.role}`;
  $('devices-toggle').hidden = !canManage();
  $('snooze').hidden = false;
  $('settings-toggle').hidden = false;
  renderSettings();
  updateNotificationButton();
  // Catch up on anything sent while this tab was closed.
  client.sync();
});

client.on('notification', (n) => {
  if (feed.some((existing) => existing.id === n.id)) return; // retries repeat ids
  feed.unshift(n);
  if (feed.length > 300) feed.pop();
  renderFeed();
  announce(announcementFor(n));
  popNotification(n);
  client.ack([n.id], { seq: n.seq });
});

/** The condition ended, so the alert should stop occupying a screen. */
client.on('resolve', ({ ids }) => {
  const resolvedAt = Date.now();
  let changed = false;
  for (const n of feed) {
    if (ids.includes(n.id) && !n.resolvedAt) {
      n.resolvedAt = resolvedAt;
      changed = true;
    }
  }
  if (changed) renderFeed();
});

/**
 * The hub going quiet is the one alert it cannot send itself, so this browser
 * raises it locally. The wording stays honest: from here, a dead service and a
 * dropped connection look identical.
 */
client.on('service:missing', ({ spec, silentForMs }) => {
  const seconds = Math.round(silentForMs / 1000);
  $('service-down-title').textContent = spec.alert.title;
  $('service-down-body').textContent =
    `${spec.alert.body ?? ''} (silent for ${seconds}s)`.trim();
  $('service-down').hidden = false;
  announce(`${spec.alert.title}. ${spec.alert.body ?? ''}`);

  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(spec.alert.title, {
      body: spec.alert.body,
      tag: 'notifyjs-service-down',
      requireInteraction: true,
    });
  }
});

client.on('service:back', ({ downForMs }) => {
  $('service-down').hidden = true;
  announce(`Connection restored after ${Math.round(downForMs / 1000)} seconds.`);
});

client.on('service:bye', ({ reason }) => {
  $('service-down-title').textContent = 'Service restarting';
  $('service-down-body').textContent = reason;
  $('service-down').hidden = false;
});

$('snooze').addEventListener('click', () => {
  const button = $<HTMLButtonElement>('snooze');
  if (button.dataset.active === 'true') {
    client.unsnooze();
    button.dataset.active = 'false';
    button.textContent = 'Snooze 30m';
    announce('Notifications resumed.');
  } else {
    client.snooze(30 * 60_000);
    button.dataset.active = 'true';
    button.textContent = 'Snoozed - tap to resume';
    announce('Snoozed for 30 minutes. Critical alerts will still arrive.');
  }
});

client.on('call', openCall);

client.on('call.cancel', ({ callId }) => {
  if (activeCall?.id === callId) closeCall();
});

client.on('paired', () => {
  $('pair-error').hidden = true;
});

client.on('revoked', () => {
  closeCall();
  showPairing('This device was revoked by an administrator.');
});

client.on('error', (err) => {
  if (err.code === 'pair_failed') {
    showPairing('Pairing failed. The code may be expired or already used.');
  }
});

/* ---------------------------------------------------------------- */
/* Staying current                                                   */
/* ---------------------------------------------------------------- */

/**
 * The dashboard is served by the hub, so upgrading the hub is what ships a new
 * dashboard - but a tab left open keeps running the old assets indefinitely.
 * Noticing the version changed and offering a reload closes that gap without
 * ever reloading out from under someone mid-incident.
 */
let loadedVersion: string | undefined;

async function checkHubVersion(): Promise<void> {
  try {
    const info = (await (await fetch('./hub.json', { cache: 'no-store' })).json()) as {
      version?: string;
    };
    if (!info.version) return;

    if (loadedVersion === undefined) {
      loadedVersion = info.version;
      return;
    }
    if (info.version === loadedVersion) return;

    $('app-update-text').textContent = `NotifyJS ${info.version} is running on the hub.`;
    $('app-update').hidden = false;
  } catch {
    // The hub being briefly unreachable is the watchdog's business, not this.
  }
}

$('app-update-reload').addEventListener('click', () => location.reload());

/** Coming back from background may have missed frames; resync. */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && client.status === 'ready') client.sync();
});

async function main(): Promise<void> {
  buildFilters();
  wireSettings();
  renderFeed();

  void checkHubVersion();
  // Slow on purpose: this is a courtesy, not a race.
  setInterval(() => void checkHubVersion(), 10 * 60_000);
  if (await client.isPaired()) {
    showApp();
    await client.connect();
  } else {
    showPairing();
  }
}

void main();
