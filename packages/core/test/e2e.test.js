import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

import { Notifier } from '../dist/index.js';
import { NotifyClient, memoryStorage } from '@osqd/notifyjs-protocol';
import { nodeCrypto } from '@osqd/notifyjs-protocol/node';

/**
 * Chosen by the OS, not by this file. Fixed ports made the suite fail in
 * bursts whenever a port was still held from an earlier run - every test in
 * the file at once, for a reason that had nothing to do with the code.
 */
let PORT = 0;
let hub;
let storeDir;

/** Wraps a device in the same client the phone and dashboard use. */
function makeClient(name, opts = {}) {
  return new NotifyClient({
    url: `ws://127.0.0.1:${PORT}`,
    crypto: nodeCrypto,
    storage: opts.storage ?? memoryStorage(),
    createSocket: (url) => new WebSocket(url),
    deviceName: name,
    platform: 'node-test',
    ...opts,
  });
}

/** Closes a client and waits until the hub has actually dropped it. */
async function disconnectAndWait(client, deviceName) {
  const gone = new Promise((resolve) => {
    const handler = (device) => {
      if (device.name === deviceName) {
        hub.off('device:offline', handler);
        resolve();
      }
    };
    hub.on('device:offline', handler);
  });
  client.disconnect();
  await gone;
}

function once(client, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeout);
    const off = client.on(event, (payload) => {
      clearTimeout(timer);
      off();
      resolve(payload);
    });
  });
}

before(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'notifyjs-test-'));
  hub = new Notifier({
    port: 0,
    storeDir,
    dashboard: false,
    logger: false,
    defaultRingSeconds: 1,
    security: {
      uniformFailureMs: 5,
      maxFailuresBeforeBan: 3,
      banBaseMs: 500,
      // Every client here shares 127.0.0.1, so the per-IP connection bucket
      // would otherwise throttle the suite itself.
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

test('pairs a device with a code and delivers a notification', async () => {
  const { code } = hub.createPairingCode({ role: 'oncall' });
  const client = makeClient('phone');

  await client.pair(code);
  const ready = await once(client, 'ready');
  assert.equal(ready.role, 'oncall');
  assert.equal(hub.devices().length, 1);

  const received = once(client, 'notification');
  await hub.error({ title: 'Disk almost full', body: '94% on /var', channel: 'db' });
  const n = await received;
  assert.equal(n.title, 'Disk almost full');
  assert.equal(n.severity, 'error');
  await disconnectAndWait(client, 'phone');
});

test('role severity floor filters out low-priority notifications', async () => {
  const { code } = hub.createPairingCode({ role: 'oncall' });
  const client = makeClient('pager');
  await client.pair(code);
  await once(client, 'ready');

  let seen = 0;
  client.on('notification', () => seen++);

  // oncall has minSeverity 'warning', so info must not arrive.
  await hub.info({ title: 'deploy started', channel: 'ci' });
  await hub.warn({ title: 'latency spike', channel: 'ci' });
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(seen, 1, 'only the warning should reach an oncall device');
  await disconnectAndWait(client, 'pager');
});

test('reconnects with a stored keypair and replays what it missed', async () => {
  const storage = memoryStorage();
  const { code } = hub.createPairingCode({ role: 'oncall' });

  const first = makeClient('laptop', { storage });
  await first.pair(code);
  await once(first, 'ready');
  const deviceId = hub.devices().find((d) => d.name === 'laptop').id;
  await disconnectAndWait(first, 'laptop');

  // Sent while the device is offline.
  await hub.critical({ title: 'while you were away', channel: 'db' });

  const second = makeClient('laptop', { storage });
  const replayed = once(second, 'notification');
  await second.connect();
  const ready = await once(second, 'ready');

  assert.equal(ready.deviceId, deviceId, 'same identity, no re-pairing');
  assert.equal((await replayed).title, 'while you were away');
  assert.equal(hub.devices().length, 3, 'reconnect must not enrol a new device');
  await disconnectAndWait(second, 'laptop');
});

test('places a call, escalates past a decline, and resolves when answered', async () => {
  const a = makeClient('first-phone');
  const b = makeClient('second-phone');
  await a.pair(hub.createPairingCode({ role: 'oncall' }).code);
  await once(a, 'ready');
  await b.pair(hub.createPairingCode({ role: 'oncall' }).code);
  await once(b, 'ready');

  // Whoever is rung first declines; the hub must move on to the other device.
  a.on('call', (c) => a.declineCall(c.id));
  b.on('call', (c) => b.declineCall(c.id));

  const declined = await hub.call({ message: 'database is down', ringSeconds: 1 });
  assert.equal(declined.outcome, 'declined');
  assert.equal(declined.attempted.length, 2, 'both devices should have been tried');

  await disconnectAndWait(a, 'first-phone');
  await disconnectAndWait(b, 'second-phone');
});

test('answering a call reports which device took it', async () => {
  const client = makeClient('answering-phone');
  await client.pair(hub.createPairingCode({ role: 'oncall' }).code);
  await once(client, 'ready');

  const spoken = [];
  client.on('call', (c) => {
    spoken.push(c.message);
    client.answerCall(c.id);
  });

  const result = await hub.call({ message: 'production is on fire', ringSeconds: 2 });
  assert.equal(result.outcome, 'answered');
  assert.equal(result.deviceName, 'answering-phone');
  assert.deepEqual(spoken, ['production is on fire']);
  await disconnectAndWait(client, 'answering-phone');
});

test('an unanswered call resolves as missed', async () => {
  const client = makeClient('silent-phone');
  await client.pair(hub.createPairingCode({ role: 'oncall' }).code);
  await once(client, 'ready');
  client.on('call', () => {});

  const result = await hub.call({ message: 'nobody is listening', ringSeconds: 1 });
  assert.equal(result.outcome, 'missed');
  await disconnectAndWait(client, 'silent-phone');
});

test('a viewer role is never rung', async () => {
  const viewer = makeClient('wall-display');
  await viewer.pair(hub.createPairingCode({ role: 'viewer' }).code);
  await once(viewer, 'ready');

  let rang = false;
  viewer.on('call', () => (rang = true));
  const result = await hub.call({ message: 'should not ring', ringSeconds: 1 });

  assert.equal(rang, false);
  assert.equal(result.outcome, 'failed', 'no call-capable device is reachable');
  await disconnectAndWait(viewer, 'wall-display');
});

test('a used pairing code cannot be redeemed twice', async () => {
  const { code } = hub.createPairingCode({ role: 'viewer' });
  const first = makeClient('one');
  await first.pair(code);
  await once(first, 'ready');
  await disconnectAndWait(first, 'one');

  const second = makeClient('two');
  const failure = once(second, 'error');
  await second.pair(code);
  assert.equal((await failure).code, 'pair_failed');
  // This client never paired, so there is no device for the hub to drop.
  second.disconnect();
});
