import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

import { Notifier } from '../dist/index.js';
import { NotifyClient, memoryStorage } from '@osqd/notifyjs-protocol';
import { nodeCrypto } from '@osqd/notifyjs-protocol/node';

/**
 * The device watches the hub, not the other way round.
 *
 * This is the failure an embedded hub can never report: it dies with the
 * process. These tests kill hubs in various ways and assert the paired device
 * notices - and, just as importantly, that it stays quiet when it should.
 */

async function hubWith(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'notifyjs-dw-'));
  const hub = new Notifier({
    // Chosen by the OS. Fixed ports from 7921 up meant two runs on one machine -
    // or anything else holding one - failed the whole file with EADDRINUSE, which
    // is why `e2e` and `sources` moved off them.
    port: 0,
    storeDir: dir,
    dashboard: false,
    logger: false,
    deviceWatchdog: { intervalMs: 200, graceMs: 200, ...options.deviceWatchdog },
    security: {
      connectionBurst: 500,
      connectionRefillPerSec: 100,
      maxConnectionsPerIp: 200,
    },
    ...options.notifier,
  });
  await hub.start();
  return {
    hub,
    dir,
    port: Number(new URL(hub.url).port),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function deviceFor(p, extra = {}) {
  return new NotifyClient({
    url: `ws://127.0.0.1:${p}`,
    crypto: nodeCrypto,
    storage: extra.storage ?? memoryStorage(),
    createSocket: (url) => new WebSocket(url),
    deviceName: 'watcher',
    platform: 'node-test',
    ...extra,
  });
}

function once(client, event, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeout);
    const off = client.on(event, (payload) => {
      clearTimeout(timer);
      off();
      resolve(payload);
    });
  });
}

test('the hub hands each device a watchdog contract on connect', async () => {
  const { hub, port: p, cleanup } = await hubWith({ notifier: { name: 'Checkout Service' } });
  const device = deviceFor(p);

  await device.pair(hub.createPairingCode({ role: 'oncall' }).code);
  await once(device, 'ready');
  await new Promise((r) => setTimeout(r, 200));

  const spec = device.watchdog;
  assert.ok(spec, 'the device was told what to watch for');
  assert.equal(spec.enabled, true);
  assert.equal(spec.intervalMs, 200);
  // The hub names itself, because only it knows what it is.
  assert.match(spec.alert.title, /Checkout Service may be down/);
  assert.equal(spec.alert.severity, 'critical');

  device.disconnect();
  await hub.stop();
  cleanup();
});

test('a device raises the alarm when the hub dies without warning', async () => {
  const { hub, port: p, cleanup } = await hubWith({ notifier: { name: 'Checkout Service' } });
  const device = deviceFor(p, { isOnline: () => true });

  await device.pair(hub.createPairingCode({ role: 'oncall' }).code);
  await once(device, 'ready');

  const missing = once(device, 'service:missing', 8000);

  // A crash, not a shutdown. `hub.stop()` always sends `bye` - a reason string does
  // not change that - and a device receiving one holds its alarm for four intervals
  // plus the grace. So this test used to be measuring the announced-restart path
  // while claiming to measure an unannounced death, and its assertion was loose
  // enough to pass either way. Tearing the sockets down without a frame is what a
  // process disappearing looks like from here.
  for (const session of hub.sessions.values()) session.ws.terminate();
  const event = await missing;

  // Inside the interval and its grace, and comfortably below the hold a `bye`
  // would have earned - which is what distinguishes the two paths.
  assert.ok(event.silentForMs >= 200, 'it waited out the promised interval');
  assert.ok(event.silentForMs < 1_000, `it did not wait out a farewell hold: ${event.silentForMs}`);
  assert.equal(event.certain, true, 'the device knew its own network was fine');
  assert.match(event.spec.alert.title, /Checkout Service may be down/);
  assert.equal(device.serviceLooksDown, true);

  device.disconnect();
  await hub.stop();
  cleanup();
});

test('a planned shutdown does not raise the alarm the way a crash does', async () => {
  // The other side of the same coin, and the reason the farewell frame exists: a
  // deploy must not page anybody. Nothing in this file distinguished the two, so
  // removing the `bye` send entirely left it green.
  const { hub, port: p, cleanup } = await hubWith();
  const device = deviceFor(p, { isOnline: () => true });

  await device.pair(hub.createPairingCode({ role: 'oncall' }).code);
  await once(device, 'ready');

  const farewell = once(device, 'service:bye', 4000);
  await hub.stop('deploying');
  assert.match((await farewell).reason, /deploying/);

  // The alarm a crash raises within half a second must not arrive here.
  const quiet = await Promise.race([
    once(device, 'service:missing', 1500).then(() => 'alarmed'),
    new Promise((r) => setTimeout(() => r('quiet'), 1200)),
  ]);
  assert.equal(quiet, 'quiet', 'an announced shutdown is held, not paged');

  device.disconnect();
  cleanup();
});

test('a device that has lost its own network stays quiet', async () => {
  const { hub, port: p, cleanup } = await hubWith();
  // This device knows it is offline, so silence proves nothing about the hub.
  const device = deviceFor(p, { isOnline: () => false });

  await device.pair(hub.createPairingCode({ role: 'oncall' }).code);
  await once(device, 'ready');

  let alarmed = false;
  device.on('service:missing', () => (alarmed = true));

  await hub.stop('gone');
  await new Promise((r) => setTimeout(r, 1500));

  assert.equal(alarmed, false, 'a phone in a tunnel must not page anyone');
  assert.equal(device.serviceLooksDown, false);

  device.disconnect();
  cleanup();
});

test('a planned shutdown does not page anyone', async () => {
  const { hub, port: p, cleanup } = await hubWith();
  const device = deviceFor(p, { isOnline: () => true });

  await device.pair(hub.createPairingCode({ role: 'oncall' }).code);
  await once(device, 'ready');

  let alarmed = false;
  device.on('service:missing', () => (alarmed = true));
  const bye = once(device, 'service:bye', 5000);

  // A deploy: the hub says it is going, and roughly for how long.
  await hub.stop('deploying v2', 10_000);

  const farewell = await bye;
  assert.equal(farewell.reason, 'deploying v2');
  assert.equal(farewell.expectedDowntimeMs, 10_000);

  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(alarmed, false, 'an announced restart is not an incident');

  device.disconnect();
  cleanup();
});

test('the alarm clears when the hub comes back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notifyjs-dw-back-'));
  const opts = {
    storeDir: dir,
    dashboard: false,
    logger: false,
    deviceWatchdog: { intervalMs: 200, graceMs: 200 },
    security: { connectionBurst: 500, connectionRefillPerSec: 100, maxConnectionsPerIp: 200 },
  };

  // The device has to find the same address twice, so the port cannot be 0 for the
  // second hub - but it need not be picked by hand either: the OS hands one out
  // here, and it is free again the moment the first hub stops.
  const first = new Notifier({ ...opts, port: 0 });
  await first.start();
  const p = Number(new URL(first.url).port);

  const storage = memoryStorage();
  const device = deviceFor(p, { storage, isOnline: () => true, autoReconnect: true });
  await device.pair(first.createPairingCode({ role: 'oncall' }).code);
  await once(device, 'ready');

  const missing = once(device, 'service:missing', 8000);
  // Killed rather than stopped, for the same reason as the test above: `stop()`
  // sends `bye`, and a device that gets one holds its alarm.
  for (const session of first.sessions.values()) session.ws.terminate();
  await first.stop();
  await missing;
  assert.equal(device.serviceLooksDown, true);

  // Same store, so the device's identity is still known: it reconnects on its
  // own and the alarm should clear without anyone touching the phone.
  const back = once(device, 'service:back', 15_000);
  const second = new Notifier({ ...opts, port: p });
  await second.start();

  const recovery = await back;
  assert.ok(recovery.downForMs > 0);
  assert.equal(device.serviceLooksDown, false);

  device.disconnect();
  await second.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('the watchdog survives the app being restarted', async () => {
  const { hub, port: p, cleanup } = await hubWith();
  const storage = memoryStorage();

  const first = deviceFor(p, { storage });
  await first.pair(hub.createPairingCode({ role: 'oncall' }).code);
  await once(first, 'ready');
  await new Promise((r) => setTimeout(r, 200));
  first.disconnect();

  // A fresh client, as if the app had been closed and reopened. Closing the
  // app must not quietly disable the only thing watching the service.
  const second = deviceFor(p, { storage });
  await second.loadCredentials();
  assert.ok(second.watchdog, 'the contract was restored from storage');
  assert.equal(second.watchdog.intervalMs, 200);

  second.disconnect();
  await hub.stop();
  cleanup();
});

test('disabling it leaves devices unarmed', async () => {
  const { hub, port: p, cleanup } = await hubWith({ deviceWatchdog: { enabled: false } });
  const device = deviceFor(p, { isOnline: () => true });

  await device.pair(hub.createPairingCode({ role: 'oncall' }).code);
  await once(device, 'ready');
  await new Promise((r) => setTimeout(r, 200));

  let alarmed = false;
  device.on('service:missing', () => (alarmed = true));
  assert.equal(device.watchdog.enabled, false);

  await hub.stop('gone');
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(alarmed, false);

  device.disconnect();
  cleanup();
});
