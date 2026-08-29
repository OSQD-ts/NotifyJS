import type { Notification, Severity } from '@osqd/notifyjs-protocol';

/**
 * The parts of the dashboard that turn data into DOM.
 *
 * Kept apart from the socket wiring in `app.ts` so they can be exercised
 * against a real DOM in tests - in particular the rule that notification text
 * is only ever set as text, never parsed as markup.
 */

/** Formats a pairing code as the user types: XXXX-XXXX-XXXX. */
export function formatCodeInput(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .slice(0, 12)
    .replace(/(.{4})(?=.)/g, '$1-');
}

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

  const time = document.createElement('time');
  time.className = 'time';
  time.dateTime = new Date(n.ts).toISOString();
  time.textContent = new Date(n.ts).toLocaleTimeString();

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
