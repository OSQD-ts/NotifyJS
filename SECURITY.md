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

Private keys live in the best storage each platform offers, which is not the
same thing on each:

| Client | Where | What that means |
| --- | --- | --- |
| Phone | iOS Keychain / Android Keystore (`expo-secure-store`) | Protected by the OS; no easier to extract than a saved password. |
| CLI, desktop | A 0600 file in a 0700 directory | Readable by that user account, and by root. |
| Browser dashboard | `localStorage` | **Not** secure storage. Any script that runs on the hub's origin can read the seed. |

The browser is deliberately the weakest of the three and is called out here
rather than glossed over. `localStorage` is the only place a page can keep a
key across visits, and the dashboard's defence is that no third-party script
ever runs on that origin: it is served by the hub itself under
`default-src 'self'` with no inline scripts and no external assets, and every
piece of hub-supplied text is rendered with `textContent`. An XSS on the
dashboard is therefore a device compromise, which is why that CSP is not
negotiable. Revoking the device is the remedy.

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

**Only turn `trustProxy` on when the hub cannot be reached except through that
proxy.** It makes the client IP a value the client sends. The hub requires it
to parse as an address, so it cannot be used to spray arbitrary keys into the
ban store, but a peer that can reach the port directly can still name a
different address on every connection and walk past both the per-IP limits and
any ban. Bind the hub to the loopback interface, or firewall the port to the
proxy, whenever this is set.

## Cross-origin requests

`allowedOrigins` defaults to `same-origin`: a browser `Origin` is accepted only
when its host matches the request's `Host`, which is what the hub's own
dashboard always sends. Note the limit of comparing the two headers: a name an
attacker controls, rebound to the hub's address, satisfies both. That buys
them an unauthenticated socket and nothing more — the handshake still needs a
device key — but it is not the same as "only your own pages can connect". Pass
an explicit list when that distinction matters. Without this, any page you happened to visit could open
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

Reading is filtered the same way as delivery. `history` returns only what the
calling device's role would have been delivered — its channel patterns, its
minimum severity, and the alert's own targeting all still apply. Otherwise the
capability that puts a device on the receiving end of one channel would be a
way to read every other.

**No device can hand out authority it does not hold.** These capabilities —
`notify.send`, `call.place`, `devices.manage`, `roles.manage`, `audit.read`,
`admin` — may only be granted by a device that already has them, whether the
grant is a new pairing code, a role change, or a rewritten role. Blocking
`admin` alone was not enough: each of the others composes back into it in a
move or two, since `devices.manage` mints pairing codes and `roles.manage`
writes the role they point at. The receiving-side capabilities
(`notify.receive`, `notify.ack`, `call.receive`) stay freely grantable, so
issuing an ordinary viewer code does not require admin — the rule that makes
delegation safe must not be the reason an operator hands out admin instead.

What `roles.manage` *is* allowed to do is widen its own role's channel
patterns and lower its minimum severity. That is inherent in the capability
rather than a gap in it — editing roles is what it is for — but it means
`roles.manage` should be read as "can see everything, eventually". Grant it
accordingly.

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

The token is compared in constant time. An endpoint an attacker can poll in a
loop is exactly where a `!==` on a secret becomes a way to recover it one
character at a time, and severities are validated against the known set before
they are rendered, so nothing a caller supplies can write a line into the
output.

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
the asset root.

Text that reaches a terminal is stripped of control characters first — device
names and channels at the hub, and notification titles and bodies at the CLI
client, which is where they are actually printed. Alert bodies routinely carry
stack traces and whatever a monitored service logged, and a raw escape sequence
in one of them can repaint an operator's screen or hide a line they needed to
see.

## Updates

Both self-updating clients verify what they are about to install against the
`SHA256SUMS.txt` published with the release, using one shared parser, and refuse
to continue on a mismatch or a missing entry. This is the difference between an
updater and a remote code execution primitive, so it is not optional and not
best-effort: the CLI declines to replace its binary, and the phone deletes the
downloaded APK rather than passing it to the Android installer.

The phone's install is additionally gated by Android itself, which will not
replace an installed app with one signed by a different key, and by the user
confirming the system install prompt. Neither of those says *which* build of
ours arrived, which is what the checksum is for.

## Pairing from a link

A `notifyjs://pair?...` link is a proposal, not an instruction. Anything on a
phone can fire that scheme — a web page, another app — and a hub the device
joined silently could ring it, take over a locked screen and speak through it.
The app names the host and asks before joining. Scanning a QR code is already a
deliberate act; following a link is not.

Each source is a separate identity with its own keypair under its own storage
namespace, so a hub added this way learns nothing about any other hub the
device is paired with.

## Running it as a service

The unit files under `packaging/` are part of the security model, not
convenience wrappers.

The systemd unit drops every capability (the hub listens above port 1024, so it
needs none), confines writes to its state directory, filters syscalls to
`@system-service` minus `@privileged` and `@resources`, and sets `UMask=0077`.

The launchd agent keeps its state and its log under the user's own `~/Library`.
An earlier version used `/Users/Shared`, which is mode 1777: every account on
the machine could read the store, and — because a first run prints an admin
pairing code to stdout — could read that code out of the log and pair itself as
an administrator. If you installed that version, move the data directory and
delete the old log.

## Supply chain

Third-party GitHub Actions are pinned to commit SHAs rather than tags, since a
tag is a pointer its owner can move and these workflows hold the npm and
container publishing credentials. The container base image is pinned by digest,
and `npm ci --ignore-scripts` builds it, so no dependency's lifecycle script
runs during an image build. Dependabot keeps all of it current.

Release jobs run with `contents: read`; only the two jobs that publish are
granted more, and only what they publish with. No workflow interpolates a
`${{ }}` expression into a shell command — values are passed through the
environment instead, so a version string cannot become shell syntax.

## Not covered

- **Denial of service.** Rate limits blunt casual floods; a real volumetric
  attack needs something in front of the hub.
- **A compromised device.** Its key is valid until revoked. Revoke it.
- **Message confidentiality at rest.** History is stored unencrypted in
  `store.json`; protect it with filesystem permissions (it is created 0600 in a
  0700 directory).
- **Metadata.** An observer without TLS learns when your systems are unhappy.
