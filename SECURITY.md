# Security model

NotifyJS is designed for a hub whose port is open to the internet. This
documents what it defends against, how, and what it deliberately does not.

## Threat model

The attacker can reach the port, send arbitrary bytes, open many connections,
and try codes and device IDs indefinitely. They may also read a stolen copy of
the hub's `store.json`. They cannot execute code on the hub or the devices.

## Identity

Device identity is an **Ed25519 keypair generated on the device**. Only the
public key is ever transmitted or stored. This is the single most important
choice in the design: the hub's persistent state contains nothing that can be
replayed. Someone who exfiltrates `store.json` learns which devices exist and
what they are allowed to see, but cannot authenticate as any of them.

Private keys live in the platform's secure storage: the iOS Keychain or Android
Keystore on the phone (`expo-secure-store`), `localStorage` in the browser, and
a 0600 file in a 0700 directory for the CLI.

## Handshake

1. The hub sends `hello` with a **32-byte single-use nonce**, bound to that
   socket and discarded the moment it is spent.
2. The device signs a length-prefixed transcript that includes a
   domain-separation tag, the server id, the nonce, and a timestamp.
3. The hub verifies against the stored public key.

Signature transcripts are netstring-encoded (`<len>:<value>` joined by `|`)
rather than concatenated, so an attacker cannot shift bytes between fields to
produce a different-but-valid transcript. Domain tags (`notifyjs/auth/v1`,
`notifyjs/pair/v1`) mean a signature captured from one context is invalid in
any other.

Replay is impossible because the nonce is per-connection and single-use.
Timestamps outside a 60-second skew window are refused, so even a captured
frame replayed against its own connection is short-lived.

## Pairing codes

- 50 bits of entropy, Crockford base32, formatted `XXXX-XXXX-XXXX`.
- Single-use and time-limited (10 minutes by default).
- Stored **hashed**; the plaintext exists only in the operator's terminal.
- Bound to a role at creation, optionally to a set of source IPs.
- Two check characters let clients reject typos locally, so a fat-fingered code
  never spends an attempt against the rate limiter.

Against the default 5-strike lockout with escalating bans, exhausting a 50-bit
space is not a meaningful attack.

## Uniform failure

Every rejected handshake returns the same error code (`pair_failed` /
`auth_failed`) after the same floor delay, with jitter. Unknown device IDs are
verified against a decoy public key so that "no such device" costs the same
time as "bad signature". An attacker learns "no" and nothing else — never
"close", which is what would make guessing tractable.

## Rate limiting and bans

The layers are independent, so working around one still runs into the next:

| Layer | Default |
| --- | --- |
| New connections per IP | token bucket, burst 10, refill 0.5/s |
| Concurrent connections per IP | 10 |
| Unauthenticated sockets, hub-wide | 100 |
| Handshake deadline | 10s |
| Failures before ban | 5 within a 15-minute window |
| Ban length | 60s, doubling per offence, capped at 24h |
| Frame size | 64 KB |
| Post-auth message rate | 60 per 10s |

Bans are persisted, so a restart does not grant an attacker a clean slate, and
they are enforced at the TCP upgrade — a banned IP gets a `429` and never
reaches the WebSocket layer. A successful handshake clears an IP's failure
count but **not** its backoff level, so an attacker cannot reset their penalty
by interleaving one valid login from a device they already control.

Behind NAT or a proxy, set `security.trustProxy = true` and raise
`maxConnectionsPerIp` — otherwise every device behind one address shares a
budget, and the limiter sees only the proxy.

## Cross-origin requests

`allowedOrigins` defaults to `same-origin`: a browser `Origin` is accepted only
when its host matches the request's `Host`, which is what the hub's own
dashboard always sends. Without this, any page you happened to visit could open
a WebSocket to a hub on your network — it could not authenticate, but it could
probe and consume connection budget. Non-browser clients send no `Origin` and
are unaffected; they still have to authenticate. Set `'*'` to disable the
check, or pass an explicit list when the dashboard is served from elsewhere.

## Authorization

Roles are enforced on every single delivery, not at subscription time, so
changing a role takes effect immediately for connected devices. Every
privileged operation maps to a least-privilege capability; a `viewer` cannot
enumerate devices, and only `roles.manage` can rewrite a role. Revocation
disconnects live sessions and makes the device's key permanently useless.

## The device watchdog

Devices raise a *local* alarm when the hub goes quiet. Nothing is trusted from
the network to do it: the spec arrives over the authenticated session, and the
alarm is rendered by the device itself, so a hub that has been taken over
cannot suppress it by staying silent — silence is the trigger.

The inverse is worth stating: an attacker who can partition a device from the
hub can *cause* a false alarm. That is a nuisance, not a compromise, and it is
the same signal a genuine outage produces. Devices withhold the alarm when they
know their own network is down, which removes the most common false positive
without pretending the distinction is always knowable.

## Backpressure

Every other defence here runs before authentication. One does not: a device
that authenticates and then simply stops reading its socket would make the hub
buffer without limit, since there is nowhere for TCP backpressure to go once
the write has been accepted. Past `security.maxBufferedBytes` (1 MB) the
session is dropped. Nothing is lost — the device re-syncs from its ack cursor
when it reconnects.

## Metrics

`/metrics` exposes counts only: notifications by severity, call outcomes, auth
failures, bans, uptime. No titles, channels, device names or IPs, so scraping
it cannot reveal what an alert said or who received it. Set `metricsToken` to
require `Authorization: Bearer <token>`, or `metrics: false` to remove the
endpoint.

## Push wake-ups

Push is **off by default**, and turning it on is a deliberate trade against
everything else here. When enabled, the hub asks a push service to wake devices
that are not connected, which means the notification title leaves your
infrastructure and passes through Expo and then Apple or Google. The body is
withheld unless you set `includeBody`. Point `endpoint` at a relay you run to
keep the traffic in-house. Tokens are supplied by the device and can be
withdrawn by it at any time.

## Transport

The protocol protects against replay and forgery but **not** against
eavesdropping: notification content and pairing codes are plaintext on the
wire. Run TLS (`tls: { cert, key }`, or a reverse proxy) for anything beyond
localhost. Without it, someone on the path can read your alerts and — during
the ten-minute window a code is live — race you to use it.

## The dashboard

Served with `default-src 'self'`, no inline scripts, no external assets, and
`frame-ancestors 'none'`. All notification text is rendered with
`textContent`, never `innerHTML`. Static paths are normalised and confined to
the asset root. Device-supplied names are stripped of control characters before
they reach a terminal or a log.

## Not covered

- **Denial of service.** Rate limits blunt casual floods; a real volumetric
  attack needs something in front of the hub.
- **A compromised device.** Its key is valid until revoked. Revoke it.
- **Message confidentiality at rest.** History is stored unencrypted in
  `store.json`; protect it with filesystem permissions (it is created 0600 in a
  0700 directory).
- **Metadata.** An observer without TLS learns when your systems are unhappy.
