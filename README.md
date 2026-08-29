# NotifyJS

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

## What is in the box

Published to npm under the [`@osqd`](https://www.npmjs.com/org/osqd) scope.
Every push to the default branch publishes a rolling prerelease under the
`next` tag; version tags publish under `latest`, which is what a plain
`npm install` gives you.

```bash
npm install @osqd/notifyjs        # the released version
npm install @osqd/notifyjs@next   # the rolling build from main
```

| Package | What it is |
| --- | --- |
| `@osqd/notifyjs` | The library you import. Embeds the hub, RBAC, and call orchestration. |
| `@osqd/notifyjs-protocol` | Wire protocol, RBAC model, and the client every device shares. |
| `@osqd/notifyjs-web` | Self-hosted dashboard, served by the hub itself at `http://host:7741`. |
| `@osqd/notifyjs-cli` | `notifyjs serve` for a standalone hub, `notifyjs listen` to turn a desktop into a device. |
| `@osqd/notifyjs-mobile` | React Native (Expo) app: notification feed plus a full-screen call screen with TTS. |

The icon is generated from one SVG source (`assets/icon.svg`) into every size
each platform wants — launcher, Android adaptive foreground, splash, monochrome
status-bar glyph, and the web favicon — with `npm run icons`.

```
your app  ──imports──►  @osqd/notifyjs
                             │  WebSocket server on :7741
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
  web dashboard        phone (Expo RN)      notifyjs listen
  browser alerts       ringtone + TTS       desktop notifications
  + speech synth       full-screen call     + spd-say / say
```

## Download

Grab a build from [Releases](../../releases) — none of them need Node.js
installed. Every push to the default branch refreshes a **Latest build**
prerelease, so there is always something current to download; tagged versions
(`v0.2.0`) get their own permanent release.

| Platform | File |
| --- | --- |
| Linux | `notifyjs-linux-x64.tar.gz`, `notifyjs-linux-arm64.tar.gz` |
| macOS | `notifyjs-macos-arm64.tar.gz`, `notifyjs-macos-x64.tar.gz` |
| Windows | `notifyjs-windows-x64.zip` |
| Android | `notifyjs-android-*.apk` (sideload) |
| Container | `ghcr.io/<owner>/notifyjs` |

```bash
tar xzf notifyjs-linux-x64.tar.gz
cd notifyjs
./notifyjs serve --port 7741
```

It prints a pairing code; open <http://localhost:7741> and enter it. Keep the
`dashboard` directory next to the binary, or point elsewhere with
`--dashboard-dir`.

As a service:

```bash
docker run -d -p 7741:7741 -v notifyjs:/data ghcr.io/<owner>/notifyjs
```

macOS binaries are unsigned, so clear the quarantine flag first:
`xattr -d com.apple.quarantine ./notifyjs`.

## Getting started from source

```bash
npm install
npm run build
node examples/basic/demo.mjs
```

The demo prints a pairing code. Open `http://localhost:7741`, type it in, and
leave the tab open — notifications start arriving immediately, and a spoken
call follows once the simulated disk fills up.

To run a hub without embedding it in anything:

```bash
npx notifyjs serve --port 7741 --hub-name "Home Lab"
```

To turn a laptop or server into a receiving device:

```bash
npx notifyjs pair XXXX-XXXX-XXXX --url ws://hub.example.com:7741
npx notifyjs listen --url ws://hub.example.com:7741
```

## Pairing and roles

A device joins by redeeming a **pairing code**: 12 Crockford-base32 characters,
single-use, and valid for ten minutes by default.

```ts
const issued = notify.createPairingCode({ role: 'oncall', ttlMs: 600_000 });
console.log(issued.code);         // 4F2K-9QX7-B3M1
console.log(issued.qr.terminal);  // scannable QR, straight into the terminal
```

The code comes with a **pairing link** (`notifyjs://pair?hub=...&code=...`) and
that link as a QR, in SVG for the dashboard and half-blocks for a terminal.
Scanning it carries the hub address as well as the code, so nobody has to type
`ws://192.168.1.10:7741` on a phone keyboard. `notifyjs serve` prints one on
first run.

The code carries a **role**, and the device inherits it. A role decides which
channels a device sees, how urgent a notification has to be, and whether the
device can be rung at all.

```ts
notify.upsertRole({
  name: 'night-oncall',
  channels: ['db.*', 'payments', '!db.debug'],
  minSeverity: 'error',
  capabilities: ['notify.receive', 'notify.ack', 'call.receive'],
  quietHours: { start: 1, end: 7 },   // critical calls still get through
});
```

Three roles ship by default:

| Role | Channels | Floor | Rings? |
| --- | --- | --- | --- |
| `admin` | everything | `debug` | yes, plus device and role management |
| `oncall` | everything | `warning` | yes |
| `viewer` | everything except `debug.*` | `info` | no |

Channel patterns take `*` as a wildcard and a leading `!` to exclude;
exclusions always win, so `['*', '!debug.*']` reads the way you would say it.

Capabilities are checked on every delivery and every privileged operation:
`notify.receive`, `notify.ack`, `notify.send`, `call.receive`, `call.place`,
`devices.manage`, `roles.manage`, `audit.read`, and `admin` (which implies the
rest).

## The blind spot, and how to close it

`Notifier` runs the hub **inside your process**. That is the simplest thing
that works, and it has one fatal property: when your app dies, the hub dies
with it, so the single alert you most want — *"the service is down"* — is the
one it structurally cannot send.

### Your devices are the watchdog

This is on by default and needs nothing extra. When a device connects, the hub
tells it how often it will be heard from and what to say if it stops:

```ts
new Notifier({
  name: 'Checkout Service',
  deviceWatchdog: {
    enabled: true,       // default
    intervalMs: 30_000,  // the hub promises to be heard from this often
    graceMs: 30_000,     // extra silence tolerated before the alarm
    severity: 'critical',
  },
});
```

Every paired phone, browser tab and `notifyjs listen` daemon then arms a local
timer. If your process crashes, hangs, or the machine loses power, the silence
itself is the signal and **each device raises the alarm on its own** — a
notification on the phone, a banner in the dashboard, a desktop notification on
the laptop. No third party, no external hub.

Two things keep it from crying wolf:

- **A device that knows it is offline stays quiet.** A phone in a tunnel
  produces exactly the same silence as a dead server, so each client checks its
  own connectivity first (`navigator.onLine`, `expo-network`, a DNS lookup)
  and holds its fire when it cannot tell the difference.
- **Planned restarts do not page anyone.** `stop()` sends a farewell, so a
  deploy is announced rather than alarming:

  ```ts
  await notify.stop('deploying v2', 30_000); // reason, expected downtime
  ```

Be clear-eyed about what a device can prove: only that *it* stopped hearing the
service. The alert says so. It cannot distinguish a crashed hub from a severed
network, and on a phone it only works while the app is alive — a machine
running `notifyjs listen` is the most reliable watcher, because it is always on.

### Or run the hub somewhere else

For jobs and services where you want the watching done centrally instead:

```bash
notifyjs serve --port 7741        # on a box that stays up
```

```ts
import { RemoteNotifier } from '@osqd/notifyjs';

const notify = new RemoteNotifier({
  url: 'wss://alerts.example.com:7741',
  pairingCode: process.env.NOTIFY_PAIRING_CODE, // first run only
});

// Declare a heartbeat and keep it beating for as long as this process lives.
await notify.keepAlive('checkout-service', { every: '30s', grace: '15s' });

await notify.error({ title: 'Payment provider timing out' });
```

`RemoteNotifier` mirrors `Notifier`'s API, so moving between embedded and
remote is a change of constructor, not of every call site.

For cron jobs rather than long-running services, check in explicitly:

```ts
notify.expect('nightly-backup', { every: '24h', grace: '1h' });
// ...at the end of the backup:
notify.checkIn('nightly-backup');
```

or from a shell script: `notifyjs watch nightly-backup --every 24h` once, then
`notifyjs checkin nightly-backup` at the end of the job.

The two mechanisms are complements, not alternatives: device watchdogs catch
the hub dying, heartbeats catch a job that stopped running.

## Knowing whether it landed

`notify()` tells you what became of the alert, so "nobody was listening" does
not look the same as "delivered":

```ts
const sent = await notify.error({ title: 'Payment provider down' });
if (sent.reached === 0) await fallBackToSomethingElse();
```

## Repeated alerts collapse on their own

A service in a crash loop would otherwise buzz every device a thousand times.
After a few repeats of the same alert within a window, further copies are
counted rather than delivered, and released as one summary — `Deploy failed
(x47 in 1 min)`. Nothing is dropped, and `critical` never waits:

```ts
new Notifier({ flood: { windowMs: 60_000, burst: 5, alwaysDeliver: ['critical'] } });

// Titles differ but it is one incident; group them explicitly.
await notify.error({ title: `${host} unreachable`, dedupeKey: 'cluster-down' });
```

## Clearing alerts that stopped being true

```ts
await notify.error({ title: 'Disk almost full', resolveKey: 'disk:/var' });
// ...later, when it drains:
await notify.resolve('disk:/var');
```

Every device clears the alert. Without this, screens fill with warnings from
hours ago and people learn to ignore the feed.

## Calls

A call rings devices whose role has `call.receive` and resolves once it reaches
an outcome, so you can react to nobody answering:

```ts
const result = await notify.call({
  message: 'The production database is not responding.',
  lang: 'en-US',
  ringSeconds: 30,
  repeat: 2,          // say it twice after answering
  escalate: true,     // ring devices one at a time (default)
});

result.outcome;    // 'answered' | 'declined' | 'missed' | 'cancelled' | 'failed'
result.deviceName; // who picked up
result.attempted;  // every device that rang
```

With `escalate: true` the hub rings the most recently seen device first and
moves on after `ringSeconds`, or immediately if someone declines. With
`escalate: false` every device rings at once and the first answer wins; the
rest are told the call was taken.

### Escalation policies

"Ring whoever was seen most recently" is a heuristic. A policy is a plan:

```ts
notify.upsertPolicy({
  name: 'oncall',
  steps: [
    { to: { devices: [alicePhone] }, ringSeconds: 45 },
    { to: { devices: [bobPhone] }, ringSeconds: 45, delaySeconds: 15 },
    { to: { roles: ['oncall'] }, ringSeconds: 60 },  // everyone
  ],
  repeat: 1,
});

await notify.call({ message: 'Production is down.', policy: 'oncall' });
```

Each rung rings for its own duration, then the next begins. A decline moves on
at once rather than waiting out the timeout.

On answer, the device speaks `message` with the platform's text-to-speech:
`speechSynthesis` in the browser, `expo-speech` on the phone, `spd-say`/`say`
on a desktop running `notifyjs listen`.

## Security

The whole point is a port that is reachable from wherever you are, which means
it is reachable by everyone else too. The design assumes that from the start —
see [SECURITY.md](SECURITY.md) for the threat model. In short:

- **Device identity is an Ed25519 keypair generated on the device.** The hub
  stores only public keys. There is no shared secret to steal, and a stolen
  copy of the hub's store cannot be used to impersonate anything.
- **Every connection is a fresh challenge.** The hub sends a single-use nonce
  and the device signs it, so a captured handshake cannot be replayed.
- **Pairing codes are single-use, expiring, role-bound, and stored hashed.**
  50 bits of entropy against a 5-strike lockout.
- **Failures are uniform.** Every rejected handshake returns the same code
  after the same delay, whether the code was unknown, expired, or wrongly
  signed — including a decoy signature check so unknown devices take as long
  as known ones.
- **Brute force is answered with escalating bans.** Repeated failures ban the
  IP for a minute, then two, doubling to a day; bans survive restarts and are
  enforced at the TCP upgrade, before any protocol runs.
- Plus: per-IP connection buckets and concurrency caps, a global cap on
  unauthenticated sockets, handshake deadlines, frame size limits, post-auth
  flood control, clock-skew rejection, origin checks, optional IP allow/deny
  lists, and an audit log.

Run it behind TLS. Either terminate in-process:

```ts
new Notifier({ tls: { cert: readFileSync('cert.pem'), key: readFileSync('key.pem') } });
```

or put it behind a reverse proxy and set `security.trustProxy = true` so
rate limiting sees real client IPs rather than the proxy's.

## Configuration

```ts
new Notifier({
  port: 7741,
  host: '0.0.0.0',
  name: 'My Service',        // shown to devices when pairing
  storeDir: '.notifyjs',     // devices, roles, history; created 0700
  dashboard: true,           // serve the web UI on the same port
  historyLimit: 500,         // notifications kept for offline replay
  ackRetryMs: 30_000,        // re-send cadence for requireAck
  defaultRingSeconds: 30,
  publicUrl: 'ws://192.168.1.10:7741', // used in pairing links; detected if omitted
  replayLimit: 50,           // most alerts replayed to a device back from offline
  heartbeatTickMs: 5_000,    // how often overdue check-ins are noticed
  deviceWatchdog: { enabled: true, intervalMs: 30_000, graceMs: 30_000 },
  metrics: true,             // serve Prometheus counters at /metrics
  metricsToken: undefined,   // require a bearer token on /metrics
  flood: { enabled: true, windowMs: 60_000, burst: 5 },
  push: { enabled: false },
  security: {
    maxConnectionsPerIp: 10, // raise this if devices share a NAT
    maxFailuresBeforeBan: 5,
    banBaseMs: 60_000,
    banMaxMs: 86_400_000,
    allowedOrigins: 'same-origin', // or '*', or an explicit list
    maxBufferedBytes: 1048576, // drop a device that stops reading its socket
    trustProxy: false,
  },
});
```

## Delivery guarantees

Notifications carry a monotonic sequence number. Each device records how far it
has acknowledged, so a device that was offline gets what it missed on
reconnect — filtered through its *current* role, so demoting a device narrows
its backlog retroactively. `requireAck: true` keeps re-delivering until a human
acknowledges it or the TTL expires.

A device returning from a long absence gets the most recent `replayLimit`
notifications plus a note saying how many older ones were skipped, rather than
several hundred at once.

Clients sign against the hub's clock rather than their own, so a phone or VM
whose time has drifted still authenticates instead of failing forever.

## Events

```ts
notify.on('device:paired', (device) => audit(device));
notify.on('device:online', (device) => {});
notify.on('ack', ({ notificationId, deviceId, action }) => {});
notify.on('call', (event) => {});          // ringing | answered | declined | missed
notify.on('heartbeat:missed', ({ heartbeat, overdueBy }) => {});
notify.on('heartbeat:recovered', (heartbeat) => {});
notify.on('auth:failed', ({ ip, reason }) => {});
notify.on('banned', ({ ip, until }) => alertSecurity(ip));
```

## Reaching a phone whose app is closed

A device receives while its socket is open, which on a phone means while the
app is running. Opt in to wake-ups for the rest of the time:

```ts
new Notifier({ push: { enabled: true } });
```

The phone registers a token after pairing, and the hub wakes devices that are
not connected. **This is the one place NotifyJS talks to anyone else's
servers** — alert titles pass through Expo and then Apple or Google — which is
why it is off by default and the body is withheld unless you pass
`includeBody: true`. Point `endpoint` at your own relay to keep it in-house.

## Snoozing

A device can quiet itself for a while, from the dashboard or the phone app.
`critical` still gets through — the point is to silence noise, not to turn the
pager off. Capped at 24 hours.

## Monitoring the hub itself

`GET /metrics` returns Prometheus counters: notifications by severity, call
outcomes, deliveries, coalesced alerts, auth failures, bans, overdue
heartbeats, uptime. Counts only — no titles or channels — so scraping it cannot
leak the content of an alert. Set `metricsToken` to require a bearer token.

## Wiring it into an existing app

```ts
import { captureCrashes, expressErrorHandler, createLogStream } from '@osqd/notifyjs';

captureCrashes(notify, { call: true });   // uncaught exceptions + rejections
app.use(expressErrorHandler(notify));     // 5xx responses, mounted last
const logger = pino(createLogStream(notify)); // error and above
```

Each is one line, deduplicated by default so a crash loop collapses into a
single alert instead of a thousand.

## TLS

`notifyjs cert` writes a self-signed certificate covering localhost, your
hostname and every local IP, so a phone connecting by address does not fail the
handshake:

```bash
notifyjs cert
notifyjs serve --tls-cert .notifyjs/notifyjs-cert.pem --tls-key .notifyjs/notifyjs-key.pem
```

It is self-signed, so devices must be told to trust it — still far better than
plaintext, which lets anyone on the path read your alerts and race you to a
live pairing code.

## Running as a service

The release archives carry `service/notifyjs.service` (systemd, sandboxed) and
`service/dev.notifyjs.plist` (launchd). Both expect the binary at
`/usr/local/bin/notifyjs` and the dashboard at
`/usr/local/share/notifyjs-dashboard`; installation notes are in the files.

## The phone app

`packages/mobile` is an Expo app.

```bash
cd packages/mobile
npm install
npx expo start
```

Verified on a real Android build: scan the QR code your hub prints, and pairing is done — the link carries the
hub address and the code together. (Typing both by hand still works.) The app
holds a WebSocket while it is running, mirrors notifications into the OS tray,
and shows a full-screen call UI that vibrates and speaks on answer.

### Several hubs at once

A phone or dashboard can subscribe to as many hubs as you like — a home server,
a work hub, a side project — and see one merged feed. Each subscription is a
**separate identity**: its own keypair, its own role, its own history. Hubs
never learn about each other, and revoking a device on one has no effect on the
rest. Alerts are tagged with the hub they came from, and a call names its
source so you know who is ringing.

Add one by scanning its QR code or pasting a pairing link; mute one without
unpairing it; remove one and its keypair is discarded.

### Settings

Both clients have a settings screen covering what the person carrying the
device gets to decide, as opposed to what the hub's role decides for them:

- **Sources** — add, mute, remove.
- **Device name** — how this device appears in each hub's device list.
- **Show at least** — a personal severity floor. Applied *after* the role
  filter, so it can only ever narrow what you see, never widen it.
- **Sound and vibration**, and desktop notification permission on the web.
- **Speech** — whether answering a call reads the message aloud, how fast, and
  how many times.
- **Stay connected** (Android) — the foreground service, with the permanent
  notification it costs stated plainly.

### Calls on a locked screen

On Android the app ships a small native module (`modules/notifyjs-call`) that
raises a real incoming call rather than a banner: a `CATEGORY_CALL` notification
on a high-importance channel carrying a **full-screen intent**, with the
activity marked `showWhenLocked` and `turnScreenOn`. A call lights the screen,
takes over the keyguard, rings with the system ringtone, bypasses Do Not
Disturb, and offers Answer and Decline — answering brings the app forward and
speaks the message.

Android 14 made full-screen alerts a user-granted permission for apps that are
not the default dialer. The app detects this (`canUseFullScreen()`) and can send
the user straight to the settings page; without it the call degrades to an
ordinary high-priority notification rather than failing.

### Staying connected while the app is closed

Everything arrives over the device's WebSocket, and Android reclaims an app's
process shortly after it leaves the screen — taking the socket with it. That is
why an alerting app that works perfectly while you are looking at it can go
silent the moment you are not.

The app runs a small **foreground service** whose only job is to exist, keeping
the process and its connection alive. It starts automatically once the device
is paired, and shows a permanent low-priority notification ("Listening for
alerts") because Android requires one — that notification is the visible price
of being reachable. Alerts and calls are then posted natively rather than by a
JavaScript timer, so they arrive whether the app is in front, behind, or the
screen is off.

Unpairing stops the service.

**The one case this cannot cover:** if you *force-stop* the app from Android
settings, the system delivers nothing to it at all until you open it again —
that is an OS rule no app can work around, and only a Firebase Cloud Messaging
push can wake an app in that state. Adding FCM means a Firebase project and
sending alert titles through Google, which is the trade this project otherwise
avoids. If you need coverage for force-stopped phones, pair a machine running
`notifyjs listen` as an always-on second target.

iOS needs CallKit and PushKit for the equivalent, which is not implemented — the
in-app call screen is what runs there. The protocol needs no changes for it; the
`call` frame already carries everything a native call UI wants.

A phone only holds the socket while the app is alive. Turn on push wake-ups
(above) for alerts that must arrive when the app has been swiped away, or pair
a machine that stays up (`notifyjs listen`) as a backup target.

## Testing

```bash
npm test
```

74 tests over real sockets and a real DOM:

- **Protocol** — pairing, RBAC filtering, offline replay and its cap, call
  escalation and named policies, flood coalescing, resolve, snooze, push
  wake-up against a stub push service, clock-skew correction, pairing links.
- **Security** — replay rejection, brute-force bans, oversized frames,
  capability enforcement, cross-origin refusal, revocation, and backpressure
  against a peer that authenticates and then stops reading.
- **Resilience** — the dead-man's switch in both directions: a heartbeat that
  stops being sent raises an alert, and a hub that goes quiet is reported by
  the devices watching it — including the cases where it must *not* fire (an
  offline device, an announced restart). Plus store durability under corruption
  and restart, and metrics.
- **Adapters** — crash capture, HTTP middleware, log forwarding.
- **Dashboard** — rendering against jsdom, including the rule that alert text is
  never parsed as markup.
- **CLI** — driven as a subprocess against a live hub.

## Staying up to date

**The hub and CLI** update themselves:

```bash
notifyjs update --check     # what is available
notifyjs update             # download, verify, replace
notifyjs update --prerelease  # track the rolling build from main
```

`serve` also mentions a newer build on startup, without blocking or nagging.

The download is checked against the release's own `SHA256SUMS.txt` before
anything is touched, and the swap is an atomic rename — so a truncated or
tampered archive never reaches the filesystem, and there is no moment where the
binary is half-written. The previous build is kept as `notifyjs.previous`,
because the likeliest thing to go wrong with an update is the new version.

**The phone app** checks on opening Settings and offers a one-tap update. It
downloads the APK and hands it to Android's installer — the app cannot install
anything itself, and the system still asks you to confirm. An alerting app that
silently replaced its own code would be a worse property than a version being a
few days old.

**The dashboard** is served by the hub, so upgrading the hub ships a new
dashboard. A tab left open notices the version changed and offers a reload
rather than reloading out from under you mid-incident.

## Releasing

CI builds and tests on every push, and additionally packages the binary and
runs it — a bundle that compiles but cannot start is a real failure mode, so
the smoke test executes the artifact rather than trusting the build.

Pushing a `v*` tag builds and publishes everything:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

That produces executables for five platforms, an Android APK, a dashboard-only
zip, a multi-arch container image on GHCR, and a GitHub Release with checksums.
`workflow_dispatch` runs the same pipeline into a draft release, for rehearsing
a change to it.

To build a binary locally:

```bash
npm run binary   # -> build/artifacts/notifyjs-linux-x64.tar.gz
```

Other targets:

```bash
npm run bundle
npm run package -- --target node20-macos-arm64 --name notifyjs-macos-arm64
npm run package -- --target node20-win-x64 --name notifyjs-windows-x64 --format zip
```

Android release signing is optional: set the `ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`
repository secrets. Without them the APK is debug-signed — installable by
sideloading, but not publishable and not upgradeable across signing keys.

## Status

Verified end to end on an Android emulator with a release build: deep-link
pairing, the Ed25519 handshake, notification delivery, offline replay and
acknowledgement, a full-screen incoming call, and answering it — the hub
reports `outcome: "answered"` back to the caller. The device watchdog is
verified against a hub killed with `process.exit(1)`: the paired client raises
the alarm on its own.

Not yet run on iOS. The shared client, protocol and crypto are the same code
paths the Android build exercises, but CallKit-style behaviour, iOS
text-to-speech and Keychain storage are untested, and distributing an IPA needs
an Apple Developer account.

## License

[OSQD Non-Resale License, Version 1.0](LICENSE) — copyright (c) 2026
Michał Płatosz.

Use it, modify it, run it in production, including at a business: operating and
monitoring your own systems is explicitly permitted, as is charging for your own
consulting or support around it. What you may not do is sell the software
itself, or offer it to third parties as a paid hosted product. Distributing it
free of charge is fine, provided the notice and this licence travel with it.

That summary is not the licence; read [LICENSE](LICENSE) for the terms.
