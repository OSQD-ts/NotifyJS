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


/**
 * The markup the focus handling in app.ts depends on.
 *
 * Every overlay is trapped and Escape-dismissed by walking its focusable
 * children. That only works if each one has some, and if the drawers carry a
 * close control - so the page is asserted rather than assumed.
 */
test('each overlay carries what the focus trap needs', () => {
  for (const id of ['call', 'settings', 'devices']) {
    const overlay = document.getElementById(id);
    assert.ok(overlay, `#${id} exists`);
    assert.ok(overlay.hasAttribute('hidden'), `#${id} starts hidden`);

    const focusable = overlay.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    assert.ok(focusable.length > 0, `#${id} has something to focus`);
  }

  // Escape closes a drawer through its own close button's handler, and the
  // call through decline; both must exist for the keyboard path to work.
  for (const id of ['settings-close', 'devices-close', 'call-decline']) {
    assert.ok(document.getElementById(id), `#${id} exists`);
  }
});

test('the call overlay is announced to assistive tech as a modal dialog', () => {
  const call = document.getElementById('call');
  assert.equal(call.getAttribute('role'), 'dialog');
  assert.equal(call.getAttribute('aria-modal'), 'true');
  // A dialog needs a name and a description, or a screen reader announces it
  // as an unlabelled region and reads nothing about the call.
  for (const attr of ['aria-labelledby', 'aria-describedby']) {
    const target = call.getAttribute(attr);
    assert.ok(target, `call has ${attr}`);
    assert.ok(document.getElementById(target), `${attr} points at a real element`);
  }
});


test('a ring stops itself even when nothing tells it to', async () => {
  // Every normal ending comes from elsewhere - the user answering, or the hub
  // sending `call.cancel`. A hub that dies mid-call sends neither, and the
  // ring then ran for as long as the page stayed open.
  const { maxRingMs } = await import('../dist/speech.js');

  // Bounded above a plausible rung, so a long escalation step is never cut
  // short, and below anything that would leave a speaker on all day.
  assert.equal(maxRingMs(30), 45_000, 'the call`s own duration plus a margin');
  assert.equal(maxRingMs(120), 135_000, 'a long rung still rings for all of it');
  assert.equal(maxRingMs(undefined), 75_000, 'a call that names no duration still ends');

  // Nothing a hub can send makes it unbounded.
  for (const hostile of [0, -1, NaN, Infinity, 1e12, 'soon']) {
    const ms = maxRingMs(hostile);
    assert.ok(ms >= 30_000 && ms <= 15 * 60_000, `bounded for ${String(hostile)}: ${ms}`);
  }
});
