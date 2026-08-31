import {
  SEVERITIES,
  formatPairingCode,
  isPairingCodeValid,
  parsePairingLink,
} from '@osqd/notifyjs-protocol';
import type { AppState, FeedEntry, Severity, SourceState } from '../shared.js';
import { button, el, toggle } from './dom.js';

/**
 * The four screens, mirroring the phone app one for one: a merged feed, a
 * pairing form, settings, and the call that interrupts all of them.
 *
 * Each is a pure function of the snapshot the main process last sent, so there
 * is no second copy of the state here to drift out of step with the sockets.
 */

export interface Actions {
  addSource(input: { url?: string; link?: string; code: string }): Promise<{ ok: boolean; error?: string }>;
  removeSource(id: string): void;
  setSourceEnabled(id: string, enabled: boolean): void;
  savePrefs(patch: Record<string, unknown>): void;
  saveDesktopPrefs(patch: Record<string, unknown>): void;
  clearFeed(): void;
  setSnooze(durationMs: number): void;
  sync(): void;
  answer(): void;
  decline(): void;
  hangUp(): void;
  navigate(view: 'feed' | 'settings' | 'add'): void;
}

/* -------------------------------- feed ------------------------------ */

export function feedScreen(state: AppState, actions: Actions, filter: Severity | 'all',
  onFilter: (next: Severity | 'all') => void): HTMLElement {
  const enabled = state.sources.filter((s) => s.enabled);
  const connected = enabled.filter((s) => s.status === 'ready').length;
  const down = state.sources.filter((s) => s.serviceDown);
  const snoozing = state.snoozedUntil > Date.now();

  // With several hubs a single status word would hide which one is unhappy.
  const summary =
    state.sources.length === 0 ? 'no sources' : `${connected}/${enabled.length} connected`;
  const dot = down.length > 0 ? 'critical' : connected === enabled.length && enabled.length > 0 ? 'ok' : 'idle';

  const header = el(
    'header',
    { class: 'header' },
    el('div', {}, el('h1', { text: 'NotifyJS' }), el('p', { class: 'sub', text: summary })),
    el(
      'div',
      { class: 'header-actions' },
      el('span', { class: `dot dot-${dot}`, title: summary }),
      button(snoozing ? 'Snoozed' : 'Snooze', () => actions.setSnooze(snoozing ? 0 : 30 * 60_000), {
        class: snoozing ? 'link active' : 'link',
      }),
      button('Settings', () => actions.navigate('settings'), { class: 'link' }),
    ),
  );

  const filters = el(
    'div',
    { class: 'filters' },
    ...(['all', ...SEVERITIES] as const).map((value) =>
      button(value, () => onFilter(value as Severity | 'all'), {
        class: value === filter ? 'chip chip-on' : 'chip',
      }),
    ),
  );

  const visible = state.feed.filter((e) => filter === 'all' || e.notification.severity === filter);

  const list = el('ul', { id: 'feed-list', class: 'feed' });
  if (visible.length === 0) {
    list.append(
      el('li', {
        class: 'empty',
        text:
          state.sources.length === 0
            ? 'No sources yet. Open Settings to add one.'
            : 'Nothing yet. Alerts from your hubs will appear here.',
      }),
    );
  } else {
    for (const entry of visible) list.append(feedItem(entry));
  }

  return el(
    'div',
    { class: 'screen' },
    header,
    ...down.map((source) =>
      el(
        'div',
        { class: 'banner', role: 'alert' },
        el('strong', { text: source.serviceDown?.title ?? 'A hub has gone quiet' }),
        source.serviceDown?.body ? el('p', { text: source.serviceDown.body }) : null,
      ),
    ),
    filters,
    list,
    el(
      'footer',
      { class: 'footer' },
      button('Refresh', () => actions.sync(), { class: 'link' }),
      button('Clear feed', () => actions.clearFeed(), { class: 'link' }),
    ),
  );
}

function feedItem(entry: FeedEntry): HTMLElement {
  const n = entry.notification;
  return el(
    'li',
    {
      class: `item sev-${n.severity}${entry.resolvedAt ? ' resolved' : ''}`,
      'aria-label': `${n.severity} alert on ${n.channel}: ${n.title}`,
    },
    el(
      'div',
      { class: 'item-top' },
      el('span', { class: 'sev', text: n.severity.toUpperCase() }),
      el('span', { class: 'channel', text: `${entry.sourceLabel} · ${n.channel}` }),
      el('time', {
        class: 'time',
        datetime: new Date(n.ts).toISOString(),
        text: new Date(n.ts).toLocaleTimeString(),
      }),
    ),
    el('h3', { text: n.title }),
    n.body ? el('p', { class: 'body', text: n.body }) : null,
    entry.resolvedAt ? el('p', { class: 'resolved-note', text: 'Resolved' }) : null,
  );
}

/* -------------------------------- pair ------------------------------ */

export function pairScreen(state: AppState, actions: Actions): HTMLElement {
  const codeInput = el('input', {
    // Identified so a re-render can hand focus and half-typed text back; see
    // `preserveLiveState` in index.ts.
    id: 'pair-code',
    class: 'field code',
    placeholder: 'XXXX-XXXX-XXXX',
    maxlength: 14,
    spellcheck: 'false',
    'aria-label': 'Pairing code',
  });
  const urlInput = el('input', {
    id: 'pair-url',
    class: 'field',
    placeholder: 'ws://192.168.1.10:7741',
    spellcheck: 'false',
    'aria-label': 'Hub address',
    value: 'ws://localhost:7741',
  });
  const error = el('p', { class: 'error' });
  const submit = button('Pair', () => void pair(), { class: 'primary' });

  /**
   * A pairing link carries both halves, so pasting one into the code box fills
   * in the address too. It is the form a hub's QR code encodes, and the thing
   * people actually have in their clipboard.
   */
  codeInput.addEventListener('input', () => {
    const link = parsePairingLink(codeInput.value.trim());
    if (link) {
      urlInput.value = link.hub;
      codeInput.value = formatPairingCode(link.code);
      return;
    }
    codeInput.value = formatPairingCode(codeInput.value);
  });
  codeInput.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') void pair();
  });

  const pair = async () => {
    // The checksum is verified here, so a mistyped code never spends an
    // attempt against the hub's lockout counter.
    if (!isPairingCodeValid(codeInput.value)) {
      error.textContent = 'That code is not valid. Check for a typo.';
      return;
    }
    error.textContent = '';
    submit.disabled = true;
    submit.textContent = 'Pairing…';
    const result = await actions.addSource({ url: urlInput.value.trim(), code: codeInput.value });
    submit.disabled = false;
    submit.textContent = 'Pair';
    if (!result.ok) error.textContent = result.error ?? 'Pairing failed.';
  };

  return el(
    'div',
    { class: 'screen centred' },
    el(
      'div',
      { class: 'card pair' },
      el('h1', { text: 'Add a source' }),
      el('p', {
        class: 'sub',
        text: 'Paste a pairing link, or enter the code your hub printed. This computer can watch as many hubs as you like.',
      }),
      codeInput,
      urlInput,
      submit,
      error,
      state.sources.length > 0
        ? button('Cancel', () => actions.navigate('settings'), { class: 'link' })
        : null,
    ),
  );
}

/* ------------------------------ settings ---------------------------- */

export function settingsScreen(state: AppState, actions: Actions): HTMLElement {
  const prefs = state.prefs;

  const section = (title: string, ...rows: (Node | null)[]) =>
    el(
      'section',
      { class: 'section' },
      el('h2', { text: title.toUpperCase() }),
      el('div', { class: 'card' }, ...rows),
    );

  const row = (label: string, hint: string | undefined, control: Node | null) =>
    el(
      'div',
      { class: 'row' },
      el('div', { class: 'row-text' }, el('span', { class: 'row-label', text: label }),
        hint ? el('span', { class: 'row-hint', text: hint }) : null),
      control,
    );

  const stepper = (value: string, dec: () => void, inc: () => void) =>
    el(
      'div',
      { class: 'stepper' },
      el('span', { class: 'row-hint', text: value }),
      button('−', dec, { 'aria-label': 'decrease' }),
      button('+', inc, { 'aria-label': 'increase' }),
    );

  const nameField = el('input', {
    id: 'pref-name',
    class: 'field',
    value: prefs.deviceName,
    'aria-label': 'Device name',
  });
  nameField.addEventListener('change', () => actions.savePrefs({ deviceName: nameField.value }));

  return el(
    'div',
    { class: 'screen' },
    el(
      'header',
      { class: 'header' },
      el('h1', { text: 'Settings' }),
      button('Done', () => actions.navigate('feed'), { class: 'link active' }),
    ),
    el(
      'div',
      { id: 'settings-scroll', class: 'scroll' },
      section(
        `Sources (${state.sources.length})`,
        state.sources.length === 0
          ? el('p', { class: 'empty', text: 'Not connected to anything yet. Add a hub to start receiving alerts.' })
          : null,
        ...state.sources.map((source) => sourceRow(source, actions)),
        el('div', { class: 'row' }, button('Add a source', () => actions.navigate('add'), { class: 'primary' })),
      ),

      section('This device', row('Name', "How this computer appears in each hub's device list", null), el('div', { class: 'row' }, nameField)),

      section(
        'Alerts',
        row('Show at least', 'Narrows what you see. It can never show more than your role allows.', null),
        el(
          'div',
          { class: 'row chips' },
          ...SEVERITIES.map((sev: Severity) =>
            button(sev, () => actions.savePrefs({ minSeverity: sev }), {
              class: prefs.minSeverity === sev ? 'chip chip-on' : 'chip',
            }),
          ),
        ),
        row('Sound', 'Play a sound with each system notification', toggle(prefs.sound, (v) => actions.savePrefs({ sound: v }))),
      ),

      section(
        'Calls',
        row('Speak the message', 'Read the alert aloud when you answer',
          toggle(prefs.speech.enabled, (v) => actions.savePrefs({ speech: { ...prefs.speech, enabled: v } }))),
        row('Speed', undefined, stepper(
          `${prefs.speech.rate.toFixed(1)}x`,
          () => actions.savePrefs({ speech: { ...prefs.speech, rate: prefs.speech.rate - 0.1 } }),
          () => actions.savePrefs({ speech: { ...prefs.speech, rate: prefs.speech.rate + 0.1 } }),
        )),
        row('Pitch', undefined, stepper(
          `${prefs.speech.pitch.toFixed(1)}x`,
          () => actions.savePrefs({ speech: { ...prefs.speech, pitch: prefs.speech.pitch - 0.1 } }),
          () => actions.savePrefs({ speech: { ...prefs.speech, pitch: prefs.speech.pitch + 0.1 } }),
        )),
        row('Repeat', undefined, stepper(
          `${prefs.speech.repeat}x`,
          () => actions.savePrefs({ speech: { ...prefs.speech, repeat: prefs.speech.repeat - 1 } }),
          () => actions.savePrefs({ speech: { ...prefs.speech, repeat: prefs.speech.repeat + 1 } }),
        )),
        row('Bring the window forward', 'Raise NotifyJS in front of your work when a call arrives',
          toggle(state.desktop.raiseOnCall, (v) => actions.saveDesktopPrefs({ raiseOnCall: v }))),
      ),

      section(
        'This computer',
        row('Start at login', 'Alerts only arrive while this app is running',
          toggle(state.desktop.launchAtLogin, (v) => actions.saveDesktopPrefs({ launchAtLogin: v }))),
        row('Start hidden', 'Begin in the tray rather than opening a window',
          toggle(state.desktop.startHidden, (v) => actions.saveDesktopPrefs({ startHidden: v }))),
      ),

      section('About', row('Version', `NotifyJS ${state.version}`, null)),
    ),
  );
}

function sourceRow(source: SourceState, actions: Actions): HTMLElement {
  const remove = button('Remove', () => {
    if (confirm(`Remove ${source.label}?\n\nThis computer will be forgotten by that hub. You will need a new pairing code to reconnect.`)) {
      actions.removeSource(source.id);
    }
  }, { class: 'link danger' });

  return el(
    'div',
    { class: 'row' },
    el(
      'div',
      { class: 'row-text' },
      el('span', { class: 'row-label', text: source.label }),
      el('span', { class: 'row-hint', text: source.url + (source.role ? ` · ${source.role}` : '') }),
      el('span', {
        class: source.status === 'ready' && !source.serviceDown ? 'status ok' : 'status',
        text: source.serviceDown ? 'not responding' : source.status,
      }),
    ),
    el('div', { class: 'row-actions' },
      toggle(source.enabled, (v) => actions.setSourceEnabled(source.id, v)), remove),
  );
}

/* -------------------------------- call ------------------------------ */

export function callScreen(state: AppState, actions: Actions, speaking: boolean): HTMLElement {
  const call = state.activeCall!;
  return el(
    'div',
    { class: `screen call sev-${call.call.severity}` },
    el(
      'div',
      { class: 'call-top' },
      el('p', { class: 'call-label', text: speaking ? 'SPEAKING' : 'INCOMING ALERT' }),
      el('h1', {
        class: 'call-from',
        // Naming the hub matters when a computer watches several, but a hub
        // whose name is already the caller's would just say it twice.
        text:
          call.call.from === call.sourceLabel
            ? call.call.from
            : `${call.call.from} · ${call.sourceLabel}`,
      }),
      el('p', { class: 'call-sev', text: call.call.severity.toUpperCase() }),
      el('p', { class: 'call-message', text: call.call.message }),
    ),
    speaking
      ? el('div', { class: 'call-actions' }, button('Hang up', () => actions.hangUp(), { class: 'big danger' }))
      : el(
          'div',
          { class: 'call-actions' },
          button('Decline', () => actions.decline(), { class: 'big danger' }),
          button('Answer', () => actions.answer(), { class: 'big go' }),
        ),
  );
}
