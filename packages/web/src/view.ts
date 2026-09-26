import { formatPairingCode, type Notification, type Severity } from '@osqd/notifyjs-protocol';

/**
 * The parts of the dashboard that turn data into DOM.
 *
 * Kept apart from the socket wiring in `app.ts` so they can be exercised
 * against a real DOM in tests - in particular the rule that notification text
 * is only ever set as text, never parsed as markup.
 */

/** Formats a pairing code as the user types. Shared with the other clients. */
export const formatCodeInput = formatPairingCode;

export function matchesFilter(n: Notification, filter: Severity | 'all'): boolean {
  return filter === 'all' || n.severity === filter;
}

/** Wraps hub-supplied SVG in a data URL, so no markup is ever parsed. */
export function qrDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

export interface ItemCallbacks {
  onAction(notification: Notification, actionId: string): void;
}

/**
 * Builds one feed row.
 *
 * Every piece of hub-supplied text goes in through `textContent`. Titles and
 * bodies routinely carry stack traces and user input, and a single `innerHTML`
 * here would turn the alerting system into an XSS delivery mechanism.
 */
export function renderNotificationItem(n: Notification, callbacks: ItemCallbacks): HTMLLIElement {
  const li = document.createElement('li');
  li.className = `item severity-${n.severity}`;
  li.dataset.id = n.id;
  if (n.resolvedAt) li.classList.add('resolved');

  const top = document.createElement('div');
  top.className = 'item-top';

  const sev = document.createElement('span');
  sev.className = 'sev-tag';
  sev.textContent = n.severity;

  const channel = document.createElement('span');
  channel.className = 'channel';
  channel.textContent = n.channel;

  const at = stamp(n.ts);
  const time = document.createElement('time');
  time.className = 'time';
  time.dateTime = at.iso;
  time.textContent = at.shown;

  top.append(sev, channel, time);

  const title = document.createElement('h3');
  title.textContent = n.title;
  li.append(top, title);

  if (n.body) {
    const body = document.createElement('p');
    body.textContent = n.body;
    li.append(body);
  }

  if (n.resolvedAt) {
    const resolved = document.createElement('p');
    resolved.className = 'resolved-note';
    resolved.textContent = 'Resolved';
    li.append(resolved);
  }

  if (n.actions?.length && !n.resolvedAt) {
    const actions = document.createElement('div');
    actions.className = 'item-actions';
    for (const action of n.actions) {
      const btn = document.createElement('button');
      btn.textContent = action.label;
      btn.type = 'button';
      if (action.style !== 'primary') btn.className = 'ghost';
      btn.addEventListener('click', () => {
        callbacks.onAction(n, action.id);
        actions.remove();
      });
      actions.append(btn);
    }
    li.append(actions);
  }
  return li;
}

/**
 * Screen readers announce an `aria-live` region only when its text changes, so
 * new alerts need a short spoken summary rather than the whole feed.
 */
export function announcementFor(n: Notification): string {
  return `${n.severity} alert on ${n.channel}: ${n.title}`;
}

/**
 * A timestamp pair, or a dash, rather than an exception.
 *
 * `toISOString()` throws `RangeError` for a `ts` that is not a finite number in
 * range. That throw lands in the middle of rendering the feed - before the `ack`
 * that follows - so the notification carrying it is never acknowledged, is
 * replayed on every sync, and throws again each time: one malformed frame
 * freezes the feed for good. The client swallows the exception, so nothing says
 * why.
 */
function stamp(ts: unknown): { iso: string; shown: string } {
  const at = new Date(typeof ts === 'number' ? ts : NaN);
  if (Number.isNaN(at.getTime())) return { iso: '', shown: '\u2014' };
  return { iso: at.toISOString(), shown: at.toLocaleTimeString() };
}

/**
 * Which role a refreshed pairing-code selector should be left on.
 *
 * Lives here, and takes the previous value as an argument, because the version
 * that read it off the element got this dangerously wrong: replacing a
 * single-select's options resets `selectedIndex` to 0, so reading `value`
 * afterwards returned the *first* role rather than the operator's choice - and
 * the first default role is `admin`. Opening Devices and clicking "Create
 * pairing code" then minted an admin code for a click that used to mint a viewer
 * one.
 */
export function nextRoleChoice(previous: string, roles: string[]): string {
  if (previous && roles.includes(previous)) return previous;
  if (roles.includes('viewer')) return 'viewer';
  return roles[0] ?? 'viewer';
}
