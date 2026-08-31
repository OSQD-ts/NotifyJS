import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

import { Notifier } from '../dist/index.js';
import {
  NotifyClient,
  canonical,
  SIG_AUTH,
  PROTOCOL_VERSION,
  encodePairingCode,
} from '@osqd/notifyjs-protocol';
import { nodeCrypto } from '@osqd/notifyjs-protocol/node';

/**
 * Chosen by the OS, not by this file. Fixed ports made the suite fail in
 * bursts whenever a port was still held from an earlier run - every test in
 * the file at once, for a reason that had nothing to do with the code.
 */
let PORT = 0;
let hub;
let storeDir;

/** Storage whose contents the test can read back, to forge frames by hand. */
function inspectableStorage() {
  const map = new Map();
  return {
    map,
    async get(k) {
      return map.get(k) ?? null;
    },
    async set(k, v) {
      map.set(k, v);
    },
    async remove(k) {
      map.delete(k);
    },
  };
}

/** Opens a raw socket so the test controls the exact bytes on the wire. */
function raw(port = PORT) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames = [];
  const waiters = [];
  ws.on('message', (d) => {
    const msg = JSON.parse(d.toString());
    frames.push(msg);
    for (const w of waiters.splice(0)) w(msg);
  });
  return {
    ws,
    frames,
    next: () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no frame')), 4000);
        waiters.push((m) => {
          clearTimeout(timer);
          resolve(m);
        });
      }),
    closed: () => new Promise((resolve) => ws.on('close', (code) => resolve(code))),
    send: (obj) => ws.send(JSON.stringify(obj)),
  };
}

before(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'notifyjs-sec-'));
  hub = new Notifier({
    port: 0,
    storeDir,
    dashboard: false,
    logger: false,
    security: {
      uniformFailureMs: 5,
      handshakeTimeoutMs: 600,
      maxMessageBytes: 4096,
      // Bans are exercised on a separate hub below; this one must survive the
      // deliberate failures these tests generate.
      maxFailuresBeforeBan: 1000,
      connectionBurst: 500,
      connectionRefillPerSec: 100,
      maxConnectionsPerIp: 200,
    },
  });
  await hub.start();
  PORT = Number(new URL(hub.url).port);
});

after(async () => {
  await hub?.stop();
  if (storeDir) rmSync(storeDir, { recursive: true, force: true });
});

test('a socket that never authenticates is dropped', async () => {
  const c = raw();
  const hello = await c.next();
  assert.equal(hello.t, 'hello');
  assert.equal(await c.closed(), 4008, 'handshake timeout closes the socket');
});

test('frames before authentication are refused', async () => {
  const c = raw();
  await c.next();
  c.send({ v: PROTOCOL_VERSION, t: 'admin', id: '1', op: 'devices.list' });
  const err = await c.next();
  assert.equal(err.code, 'unauthenticated');
  c.ws.close();
});

test('an oversized frame terminates the connection', async () => {
  const c = raw();
  await c.next();
  c.send({ v: PROTOCOL_VERSION, t: 'pair', code: 'A'.repeat(200_000) });
  assert.ok(await c.closed(), 'connection closed rather than buffered');
});

test('a captured auth frame cannot be replayed on a new connection', async () => {
  const storage = inspectableStorage();
  const client = new NotifyClient({
    url: `ws://127.0.0.1:${PORT}`,
    crypto: nodeCrypto,
    storage,
    createSocket: (url) => new WebSocket(url),
    deviceName: 'replay-victim',
    platform: 'node-test',
  });
  await client.pair(hub.createPairingCode({ role: 'viewer' }).code);
  await new Promise((r) => setTimeout(r, 300));
  client.disconnect();

  const deviceId = storage.map.get('notifyjs.deviceId');
  const keys = {
    publicKey: storage.map.get('notifyjs.publicKey'),
    secretSeed: storage.map.get('notifyjs.secretSeed'),
  };

  // Sign a genuine auth frame against connection A's nonce.
  const a = raw();
  const helloA = await a.next();
  const ts = Date.now();
  const sig = await nodeCrypto.sign(
    keys,
    canonical([SIG_AUTH, helloA.serverId, deviceId, helloA.nonce, String(ts)]),
  );
  a.send({ v: PROTOCOL_VERSION, t: 'auth', deviceId, ts, sig });
  assert.equal((await a.next()).t, 'ready', 'the genuine frame works once');
  a.ws.close();

  // Replay those exact bytes on connection B, which issued a different nonce.
  const b = raw();
  await b.next();
  b.send({ v: PROTOCOL_VERSION, t: 'auth', deviceId, ts, sig });
  const replayed = await b.next();
  assert.equal(replayed.t, 'error');
  assert.equal(replayed.code, 'auth_failed', 'nonce binding defeats the replay');
  b.ws.close();
});

test('an auth frame with a stale timestamp is refused', async () => {
  const storage = inspectableStorage();
  const client = new NotifyClient({
    url: `ws://127.0.0.1:${PORT}`,
    crypto: nodeCrypto,
    storage,
    createSocket: (url) => new WebSocket(url),
    deviceName: 'stale-clock',
    platform: 'node-test',
  });
  await client.pair(hub.createPairingCode({ role: 'viewer' }).code);
  await new Promise((r) => setTimeout(r, 300));
  client.disconnect();

  const deviceId = storage.map.get('notifyjs.deviceId');
  const keys = {
    publicKey: storage.map.get('notifyjs.publicKey'),
    secretSeed: storage.map.get('notifyjs.secretSeed'),
  };

  const c = raw();
  const hello = await c.next();
  const ts = Date.now() - 10 * 60_000;
  const sig = await nodeCrypto.sign(
    keys,
    canonical([SIG_AUTH, hello.serverId, deviceId, hello.nonce, String(ts)]),
  );
  c.send({ v: PROTOCOL_VERSION, t: 'auth', deviceId, ts, sig });
  assert.equal((await c.next()).code, 'auth_failed');
  c.ws.close();
});

test('a role without devices.manage cannot enumerate devices', async () => {
  const client = new NotifyClient({
    url: `ws://127.0.0.1:${PORT}`,
    crypto: nodeCrypto,
    storage: inspectableStorage(),
    createSocket: (url) => new WebSocket(url),
    deviceName: 'nosy-viewer',
    platform: 'node-test',
  });
  await client.pair(hub.createPairingCode({ role: 'viewer' }).code);
  await new Promise((r) => setTimeout(r, 300));

  await assert.rejects(() => client.admin('devices.list'), /forbidden/);
  await assert.rejects(() => client.admin('pair.create', { role: 'admin' }), /forbidden/);
  client.disconnect();
});

test('an admin role can manage devices and mint codes', async () => {
  const client = new NotifyClient({
    url: `ws://127.0.0.1:${PORT}`,
    crypto: nodeCrypto,
    storage: inspectableStorage(),
    createSocket: (url) => new WebSocket(url),
    deviceName: 'console',
    platform: 'node-test',
  });
  await client.pair(hub.createPairingCode({ role: 'admin' }).code);
  await new Promise((r) => setTimeout(r, 300));

  const listed = await client.admin('devices.list');
  assert.ok(listed.devices.length > 0);
  const issued = await client.admin('pair.create', { role: 'viewer' });
  assert.match(issued.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  client.disconnect();
});

test('a revoked device cannot authenticate again', async () => {
  const storage = inspectableStorage();
  const client = new NotifyClient({
    url: `ws://127.0.0.1:${PORT}`,
    crypto: nodeCrypto,
    storage,
    createSocket: (url) => new WebSocket(url),
    deviceName: 'stolen-phone',
    platform: 'node-test',
  });
  await client.pair(hub.createPairingCode({ role: 'oncall' }).code);
  await new Promise((r) => setTimeout(r, 300));
  const deviceId = storage.map.get('notifyjs.deviceId');
  client.disconnect();

  hub.revokeDevice(deviceId);

  const keys = {
    publicKey: storage.map.get('notifyjs.publicKey'),
    secretSeed: storage.map.get('notifyjs.secretSeed'),
  };
  const c = raw();
  const hello = await c.next();
  const ts = Date.now();
  const sig = await nodeCrypto.sign(
    keys,
    canonical([SIG_AUTH, hello.serverId, deviceId, hello.nonce, String(ts)]),
  );
  c.send({ v: PROTOCOL_VERSION, t: 'auth', deviceId, ts, sig });
  assert.equal((await c.next()).code, 'auth_failed', 'a valid signature is not enough once revoked');
  c.ws.close();
});

test('guessing pairing codes gets the source banned', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notifyjs-ban-'));
  const strict = new Notifier({
    port: 0,
    storeDir: dir,
    dashboard: false,
    logger: false,
    security: {
      uniformFailureMs: 1,
      maxFailuresBeforeBan: 3,
      banBaseMs: 60_000,
      connectionBurst: 500,
      connectionRefillPerSec: 100,
      maxConnectionsPerIp: 200,
    },
  });
  await strict.start();
  const strictPort = Number(new URL(strict.url).port);

  const bans = [];
  strict.on('banned', (b) => bans.push(b));

  // Each guess is a well-formed but wrong code, so it reaches the lookup.
  for (let i = 0; i < 3; i++) {
    const c = raw(strictPort);
    await c.next();
    c.send({
      v: PROTOCOL_VERSION,
      t: 'pair',
      code: encodePairingCode(nodeCrypto.randomBytes(7)),
      publicKey: 'A'.repeat(43),
      name: 'attacker',
      platform: 'bruteforce',
      sig: 'AA',
    });
    await c.closed();
  }

  assert.equal(bans.length, 1, 'the third failure trips the ban');
  assert.ok(bans[0].until > Date.now(), 'ban is in the future');

  // Further attempts are now refused at the TCP upgrade, before any protocol.
  const blocked = new WebSocket(`ws://127.0.0.1:${strictPort}`);
  const outcome = await new Promise((resolve) => {
    blocked.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    blocked.on('error', () => resolve('error'));
    blocked.on('open', () => resolve('open'));
  });
  assert.equal(outcome, 429, 'a banned IP never reaches the WebSocket layer');

  await strict.stop();
  rmSync(dir, { recursive: true, force: true });
});
