# @osqd/notifyjs

Import a library, call `notify.error(...)`, and every device you own lights up.
When something is bad enough that a banner is not sufficient, call
`notify.call(...)` and your phone rings with a spoken message.

There is no third-party push service and no relay in the middle. The hub is a
WebSocket server that runs **inside your own process**, on a port you choose
(7741 by default), and your devices connect straight to it.

```bash
npm install @osqd/notifyjs
```

```ts
import { Notifier } from '@osqd/notifyjs';

const notify = new Notifier({ port: 7741, name: 'Checkout Service' });
await notify.start();

await notify.error({
  title: 'Payment provider timing out',
  body: '14 failures in the last minute',
  channel: 'payments',
});

// When a banner is not enough, ring a human and say it out loud.
const result = await notify.call({
  message: 'The payment provider is down. Checkout is failing.',
  severity: 'critical',
});

if (result.outcome !== 'answered') {
  await pageTheBackup();
}
```

Requires Node.js 20 or newer.

## Pairing

A device joins by redeeming a **pairing code**: 12 Crockford-base32 characters,
single-use, and valid for ten minutes by default. It comes with a pairing link
(`notifyjs://pair?hub=...&code=...`) and that link as a QR, so nobody has to
type `ws://192.168.1.10:7741` on a phone keyboard.

```ts
const issued = notify.createPairingCode({ role: 'oncall', ttlMs: 600_000 });
console.log(issued.code);         // 4F2K-9QX7-B3M1
console.log(issued.qr.terminal);  // scannable QR, straight into the terminal
```

The code carries a **role**, and the device inherits it. A role decides which
channels a device sees, how urgent a notification has to be, and whether the
device can be rung at all. `admin`, `oncall` and `viewer` ship by default.

```ts
notify.upsertRole({
  name: 'night-oncall',
  channels: ['db.*', 'payments', '!db.debug'],
  minSeverity: 'error',
  capabilities: ['notify.receive', 'notify.ack', 'call.receive'],
  quietHours: { start: 1, end: 7 },   // critical calls still get through
});
```

Open `http://localhost:7741` in a browser to reach the dashboard, which the hub
serves itself from [`@osqd/notifyjs-web`](https://www.npmjs.com/package/@osqd/notifyjs-web).

## The blind spot, and how to close it

Running the hub inside your process has one fatal property: when your app dies,
the hub dies with it, so the single alert you most want — *"the service is
down"* — is the one it structurally cannot send.

**Your devices are the watchdog.** This is on by default. When a device
connects, the hub tells it how often it will be heard from; every paired phone,
browser tab and `notifyjs listen` daemon then arms a local timer, and the
silence itself becomes the signal. A device that knows it is offline stays
quiet, and `stop()` sends a farewell so a deploy is announced rather than
alarming.

```ts
new Notifier({
  deviceWatchdog: { enabled: true, intervalMs: 30_000, graceMs: 30_000 },
});

await notify.stop('deploying v2', 30_000); // reason, expected downtime
```

**Or run the hub somewhere else.** `RemoteNotifier` mirrors `Notifier`'s API,
so moving between embedded and remote is a change of constructor, not of every
call site:

```ts
import { RemoteNotifier } from '@osqd/notifyjs';

const notify = new RemoteNotifier({
  url: 'wss://alerts.example.com:7741',
  pairingCode: process.env.NOTIFY_PAIRING_CODE, // first run only
});

await notify.keepAlive('checkout-service', { every: '30s', grace: '15s' });
```

For cron jobs rather than long-running services, check in explicitly:

```ts
notify.expect('nightly-backup', { every: '24h', grace: '1h' });
notify.checkIn('nightly-backup');   // at the end of the backup
```

## What else it does

- **`notify()` reports what became of the alert**, so "nobody was listening"
  does not look the same as "delivered": `if (sent.reached === 0) …`.
- **Repeated alerts collapse.** After a few copies of the same alert in a
  window, further ones are counted and released as one summary — `Deploy failed
  (x47 in 1 min)`. `critical` never waits.
- **Alerts that stopped being true can be cleared** with `resolveKey` and
  `notify.resolve(key)`, so screens do not fill with warnings from hours ago.
- **Calls escalate.** Ring devices one at a time, or define a policy with
  `upsertPolicy` to say exactly who rings, in what order, for how long.
- **Offline devices get what they missed** on reconnect, filtered through their
  *current* role. `requireAck: true` re-delivers until a human acknowledges.
- **Prometheus counters at `/metrics`** — counts only, no titles or channels,
  so scraping it cannot leak the content of an alert.

## Wiring it into an existing app

```ts
import { captureCrashes, expressErrorHandler, createLogStream } from '@osqd/notifyjs';

captureCrashes(notify, { call: true });   // uncaught exceptions + rejections
app.use(expressErrorHandler(notify));     // 5xx responses, mounted last
const logger = pino(createLogStream(notify)); // error and above
```

`fastifyErrorHandler` and `logHandler` are there too. Each is one line,
deduplicated by default so a crash loop collapses into a single alert.

## Security

The whole point is a port reachable from wherever you are, which means it is
reachable by everyone else too. Device identity is an Ed25519 keypair generated
on the device — the hub stores only public keys. Every connection is a fresh
challenge, pairing codes are single-use and stored hashed, rejected handshakes
all fail identically after the same delay, and repeated failures ban the IP
with escalating backoff at the TCP upgrade.

Run it behind TLS, either terminated in-process or at a reverse proxy with
`security.trustProxy = true`. The full threat model is in
[SECURITY.md](https://github.com/OSQD-ts/NotifyJS/blob/main/SECURITY.md).

## Related packages

| Package | What it is |
| --- | --- |
| [`@osqd/notifyjs-cli`](https://www.npmjs.com/package/@osqd/notifyjs-cli) | `notifyjs serve` for a standalone hub, `notifyjs listen` for a desktop |
| [`@osqd/notifyjs-web`](https://www.npmjs.com/package/@osqd/notifyjs-web) | The dashboard this package serves |
| [`@osqd/notifyjs-protocol`](https://www.npmjs.com/package/@osqd/notifyjs-protocol) | Wire protocol, RBAC model, and the client every device shares |

Phone (Expo) and desktop (Electron) apps are in the repository, and built
binaries are on [Releases](https://github.com/OSQD-ts/NotifyJS/releases).

## Versions

Version tags publish under `latest`, which is what a plain install gives you.
Every push to the default branch publishes a rolling prerelease:

```bash
npm install @osqd/notifyjs@next
```

## Documentation

Full configuration, delivery guarantees, events, Web Push, and everything else:
the [project README](https://github.com/OSQD-ts/NotifyJS#readme).

## License

[OSQD Non-Resale License, Version 1.0](https://github.com/OSQD-ts/NotifyJS/blob/main/LICENSE)
— copyright (c) 2026 Michał Płatosz. Use it, modify it, run it in production
including at a business; you may not sell the software itself or offer it to
third parties as a paid hosted product. That summary is not the licence.
