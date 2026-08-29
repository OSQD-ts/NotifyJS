import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

let view;

before(async () => {
  // A real DOM, built from the page the hub actually serves - so the tests
  // exercise the same markup users get, not a hand-made fixture.
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost:7741' });

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  // Node's own `btoa` is used as-is: jsdom's fails a brand check once detached
  // from its window, and the two agree on Latin-1 semantics anyway.

  view = await import('../dist/view.js');
});

const base = {
  id: 'n1',
  seq: 1,
  ts: Date.parse('2026-01-01T12:34:56Z'),
  channel: 'db',
  severity: 'error',
  title: 'Disk almost full',
};

test('pairing codes are formatted as they are typed', () => {
  assert.equal(view.formatCodeInput('abcd'), 'ABCD');
  assert.equal(view.formatCodeInput('abcdefgh'), 'ABCD-EFGH');
  assert.equal(view.formatCodeInput('abcd-efgh-jkmn'), 'ABCD-EFGH-JKMN');
  assert.equal(view.formatCodeInput('  ab cd/ef!gh jkmn  '), 'ABCD-EFGH-JKMN');
  assert.equal(view.formatCodeInput('abcdefghjkmnPQRS'), 'ABCD-EFGH-JKMN', 'excess is trimmed');
});

test('a notification renders its severity, channel and text', () => {
  const li = view.renderNotificationItem({ ...base, body: 'On /var/lib' }, { onAction() {} });

  assert.equal(li.className, 'item severity-error');
  assert.equal(li.dataset.id, 'n1');
  assert.equal(li.querySelector('.sev-tag').textContent, 'error');
  assert.equal(li.querySelector('.channel').textContent, 'db');
  assert.equal(li.querySelector('h3').textContent, 'Disk almost full');
  assert.equal(li.querySelector('p').textContent, 'On /var/lib');
  assert.equal(li.querySelector('time').dateTime, new Date(base.ts).toISOString());
});

test('notification text is never parsed as markup', () => {
  // Titles and bodies routinely carry stack traces and user-controlled values.
  // One innerHTML here would turn the alerting system into an XSS vector.
  const nasty = {
    ...base,
    title: '<img src=x onerror="globalThis.__pwned = true">',
    body: '<script>globalThis.__pwned = true</script>',
  };
  const li = view.renderNotificationItem(nasty, { onAction() {} });
  document.body.append(li);

  assert.equal(li.querySelector('img'), null, 'no element was created from the title');
  assert.equal(li.querySelector('script'), null, 'no element was created from the body');
  assert.equal(globalThis.__pwned, undefined);
  assert.equal(li.querySelector('h3').textContent, nasty.title, 'it renders as visible text');
  li.remove();
});

test('actions fire their callback and then disappear', () => {
  const fired = [];
  const li = view.renderNotificationItem(
    {
      ...base,
      actions: [
        { id: 'ack', label: 'On it', style: 'primary' },
        { id: 'snooze', label: 'Snooze' },
      ],
    },
    { onAction: (n, id) => fired.push([n.id, id]) },
  );

  const buttons = li.querySelectorAll('.item-actions button');
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].className, '', 'the primary action is not ghosted');
  assert.equal(buttons[1].className, 'ghost');

  buttons[0].click();
  assert.deepEqual(fired, [['n1', 'ack']]);
  assert.equal(li.querySelector('.item-actions'), null, 'the row stops offering actions');
});

test('a resolved notification is marked and offers no actions', () => {
  const li = view.renderNotificationItem(
    { ...base, resolvedAt: Date.now(), actions: [{ id: 'ack', label: 'On it' }] },
    { onAction() {} },
  );
  assert.ok(li.classList.contains('resolved'));
  assert.equal(li.querySelector('.resolved-note').textContent, 'Resolved');
  assert.equal(li.querySelector('.item-actions'), null);
});

test('severity filtering', () => {
  assert.equal(view.matchesFilter(base, 'all'), true);
  assert.equal(view.matchesFilter(base, 'error'), true);
  assert.equal(view.matchesFilter(base, 'critical'), false);
});

test('QR svg becomes a data URL rather than injected markup', () => {
  const url = view.qrDataUrl('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  assert.match(url, /^data:image\/svg\+xml;base64,/);
  assert.equal(
    Buffer.from(url.split(',')[1], 'base64').toString(),
    '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  );
});

test('announcements are a single readable line', () => {
  assert.equal(
    view.announcementFor(base),
    'error alert on db: Disk almost full',
  );
});

test('the served page carries the accessibility hooks the app relies on', () => {
  const announcer = document.getElementById('announcer');
  assert.equal(announcer.getAttribute('aria-live'), 'polite');
  assert.equal(announcer.getAttribute('role'), 'status');

  const call = document.getElementById('call');
  assert.equal(call.getAttribute('role'), 'dialog');
  assert.equal(call.getAttribute('aria-modal'), 'true');
  assert.equal(call.getAttribute('aria-labelledby'), 'call-from');

  assert.equal(document.getElementById('feed').getAttribute('aria-label'), 'Notifications');
});
