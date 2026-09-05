# @osqd/notifyjs-cli

The NotifyJS command line: run a standalone hub, pair devices, and turn a
machine into something that receives alerts and answers calls.

```bash
npm install -g @osqd/notifyjs-cli
```

or without installing anything:

```bash
npx notifyjs serve --port 7741
```

Requires Node.js 20 or newer. If you would rather not have Node.js at all,
[Releases](https://github.com/OSQD-ts/NotifyJS/releases) carries a
self-contained binary for Linux, macOS and Windows.

## Run a hub

```bash
notifyjs serve --port 7741 --hub-name "Home Lab"
```

It prints a pairing code and a QR for the pairing link. Open
<http://localhost:7741>, type the code in, and the browser is a paired device.
The hub serves the dashboard itself, and your own code publishes to it with
[`@osqd/notifyjs`](https://www.npmjs.com/package/@osqd/notifyjs)'s
`RemoteNotifier`.

## Turn a machine into a device

```bash
notifyjs pair XXXX-XXXX-XXXX --url ws://hub.example.com:7741
notifyjs listen --url ws://hub.example.com:7741
```

`listen` holds a socket open, raises desktop notifications, and speaks calls
aloud through `spd-say`, `say` or SAPI. A machine running it is the most
reliable watcher you can have, because it is always on — when the hub dies, its
silence is what raises the alarm.

## Catch a job that stopped running

The one alert a dead process cannot send for itself. Declare the expectation
once, then check in at the end of the job:

```bash
notifyjs watch nightly-backup --every 24h --grace 1h
notifyjs checkin nightly-backup     # last line of the cron job
notifyjs watches                    # what the hub is expecting
```

## Commands

| Command | What it does |
| --- | --- |
| `notifyjs serve` | Run a standalone hub |
| `notifyjs listen` | Connect this machine as a device |
| `notifyjs pair <code>` | Pair this machine using a code |
| `notifyjs send <title>` | Send a notification through a paired hub |
| `notifyjs call <message>` | Ring the on-call devices and speak a message |
| `notifyjs devices` | List devices known to the hub |
| `notifyjs code` | Mint a pairing code (requires an admin device) |
| `notifyjs cert` | Generate a self-signed TLS certificate |
| `notifyjs watch <name>` | Expect a check-in, and alert when it stops |
| `notifyjs checkin <name>` | Record a check-in for a watched job |
| `notifyjs watches` | List what the hub is expecting |
| `notifyjs update` | Check for and install a newer build |

`notifyjs help` prints every option. The ones you will reach for first:

```
--url <ws://host:7741>   Hub to connect to (default ws://localhost:7741)
--store <path>           Credential file
--name <name>            Name to register this device under

serve
--port <n>               Port to listen on (default 7741)
--host <addr>            Bind address (default 0.0.0.0)
--data <dir>             Hub state directory (default .notifyjs)
--public-url <url>       Address devices should use (default: your LAN IP)
--tls-cert / --tls-key   Serve wss:// (see: notifyjs cert)
--admin-code             Also print an admin pairing code on start

code
--role <name>            Role the code grants (default viewer)
--ttl <seconds>          Lifetime of the code (default 600)
```

## TLS

`notifyjs cert` writes a self-signed certificate covering localhost, your
hostname and every local IP, so a phone connecting by address does not fail the
handshake:

```bash
notifyjs cert
notifyjs serve --tls-cert .notifyjs/notifyjs-cert.pem --tls-key .notifyjs/notifyjs-key.pem
```

Devices have to be told to trust it — still far better than plaintext, which
lets anyone on the path read your alerts and race you to a live pairing code.

## Versions

Version tags publish under `latest`. Every push to the default branch publishes
a rolling prerelease under `next`:

```bash
npm install -g @osqd/notifyjs-cli@next
```

## Documentation

The [project README](https://github.com/OSQD-ts/NotifyJS#readme) covers roles,
escalation policies, Web Push, running as a systemd or launchd service, and the
phone and desktop apps.

## License

[OSQD Non-Resale License, Version 1.0](https://github.com/OSQD-ts/NotifyJS/blob/main/LICENSE)
— copyright (c) 2026 Michał Płatosz. Use it, modify it, run it in production
including at a business; you may not sell the software itself or offer it to
third parties as a paid hosted product. That summary is not the licence.
