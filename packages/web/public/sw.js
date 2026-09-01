/**
 * The dashboard's service worker: what makes a browser a real client rather
 * than a tab that happens to be open.
 *
 * `new Notification(...)` in the page dies with the page. This runs when
 * nothing of ours does - the browser wakes it, hands it a payload the hub
 * encrypted end to end, and it draws the alert. On iOS, where a home-screen
 * web app is the only route in without a native build, this is the entire
 * notification path.
 *
 * Deliberately plain JavaScript with no imports. The dashboard is built from
 * TypeScript and its specifiers rewritten by build.mjs; a service worker with
 * an import graph would need `type: 'module'`, which is recent enough in
 * Safari to be a needless bet for forty lines of code.
 */

// A new worker takes over as soon as it is installed, rather than waiting for
// every tab to close. Otherwise a browser that had the dashboard open once
// keeps delivering through the old one indefinitely.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  // Browsers permit a push with no payload, and some services strip one on
  // error. Showing *something* matters more than showing the right thing: a
  // push that resolves without a notification makes some browsers display
  // their own "this site was updated in the background" message instead.
  let payload = { title: 'NotifyJS', body: 'A new alert arrived.' };
  try {
    if (event.data) payload = event.data.json();
  } catch {
    // Keep the fallback.
  }

  const severity = String(payload.severity ?? '').toLowerCase();

  event.waitUntil(
    self.registration.showNotification(payload.title ?? 'NotifyJS', {
      body: payload.body ?? '',
      // Same tag replaces rather than stacks, which is what makes a repeated
      // alert one line on the lock screen instead of forty.
      tag: payload.tag,
      icon: './icon-192.png',
      badge: './icon-192.png',
      // A pager should not be dismissed by walking past the phone.
      requireInteraction: severity === 'critical',
      data: { url: payload.url ?? './' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url ?? './', self.location.href).href;

  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Focus a dashboard that is already open rather than stacking another
      // copy of it, which is what a second window of a pager amounts to.
      for (const client of open) {
        if (client.url.startsWith(new URL('./', self.location.href).href) && 'focus' in client) {
          await client.focus();
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(target);
    })(),
  );
});
