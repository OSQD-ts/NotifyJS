# @osqd/notifyjs-protocol

The wire protocol, RBAC model and crypto primitives shared by every NotifyJS
peer — the hub, the dashboard, the phone app, the desktop app and the CLI all
speak this and nothing else.

```bash
npm install @osqd/notifyjs-protocol
```

**Most people never install this directly.** It comes in as a dependency of
[`@osqd/notifyjs`](https://www.npmjs.com/package/@osqd/notifyjs), which
re-exports all of it. Install it on its own when you are writing a *client* —
a new app, an integration, something that connects to a hub rather than runs
one.

## What is in it

- **`NotifyClient`** — the device side of the connection, complete: pairing,
  the Ed25519 handshake, reconnection with backoff, offline replay,
  acknowledgement, calls, and the local watchdog that raises the alarm when the
  hub goes silent. The dashboard, the Expo app and `notifyjs listen` are all
  this class plus a UI.
- **Crypto providers** — `nodeCrypto` from `@osqd/notifyjs-protocol/node`,
  `webCrypto` from `@osqd/notifyjs-protocol/web`. Same interface, so the client
  does not know which platform it is on.
- **The RBAC model** — `channelMatches`, `hasCapability`, `canDeliver`,
  `inQuietHours`, `sanitizeRole`, `defaultRoles`. The hub enforces with these;
  a client uses them to predict what it will be shown.
- **Pairing codes and links** — `encodePairingCode`, `isPairingCodeValid`,
  `buildPairingLink`, `parsePairingLink`. Codes are checksummed, so a typo is
  caught locally instead of costing an attempt against the hub's lockout.
- **Message types, canonical encoding and hashing** — what gets signed, and the
  one byte-exact way of producing it.

## Writing a client

Bring a socket, a crypto provider and somewhere to keep credentials, and the
rest is handled:

```ts
import { NotifyClient, memoryStorage } from '@osqd/notifyjs-protocol';
import { nodeCrypto } from '@osqd/notifyjs-protocol/node';
import WebSocket from 'ws';

const client = new NotifyClient({
  url: 'wss://alerts.example.com:7741',
  crypto: nodeCrypto,
  storage: memoryStorage(),          // `webStorage()` in a browser
  createSocket: (url) => new WebSocket(url) as never,
  deviceName: 'build-server',
  platform: 'node',
  autoReconnect: true,
  // A device that knows it is offline must not claim the service is down.
  isOnline: () => true,
});

client.on('notification', (n) => console.log(n.severity, n.title));
client.on('call', (request) => answerOrDecline(request));

await client.connect();
await client.pair('4F2K-9QX7-B3M1');   // first run only
```

`storagePrefix` namespaces the stored credentials, which is how one app holds a
separate identity per hub — its own keypair, its own role, its own history.
Hubs never learn about each other.

## Stability

Versions move together across the whole `@osqd/notifyjs-*` set, and the hub
checks protocol compatibility on connect. Pin the same version you pin for the
hub you are talking to.

Version tags publish under `latest`; every push to the default branch publishes
a rolling prerelease under `next`.

## Documentation

The [project README](https://github.com/OSQD-ts/NotifyJS#readme) for what the
system does, and
[SECURITY.md](https://github.com/OSQD-ts/NotifyJS/blob/main/SECURITY.md) for
the threat model this protocol was shaped by.

## License

[OSQD Non-Resale License, Version 1.0](https://github.com/OSQD-ts/NotifyJS/blob/main/LICENSE)
— copyright (c) 2026 Michał Płatosz. Use it, modify it, run it in production
including at a business; you may not sell the software itself or offer it to
third parties as a paid hosted product. That summary is not the licence.
