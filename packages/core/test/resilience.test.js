import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

import { Notifier, RemoteNotifier, Watchdog, parseDuration, formatDuration } from '../dist/index.js';
import { NotifyClient, memoryStorage } from '@notifyjs/protocol';
import { nodeCrypto } from '@notifyjs/protocol/node';

const PORT = 7881;
let hub;
let storeDir;

function makeClient(name, storage = memoryStorage()) {
  return new NotifyClient({
    url: `ws://127.0.0.1:${PORT}`,
    crypto: nodeCrypto,
    storage,
    createSocket: (url) => new WebSocket(url),
    deviceName: name,
    platform: 'node-test',
  });
}

/**
 * The client's `on()` hands back an unsubscribe function; Node's EventEmitter
 * hands back the emitter. They are not interchangeable.
 */
function onHub(event, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeout);
    hub.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
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

before(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'notifyjs-res-'));
  hub = new Notifier({
    port: PORT,
    storeDir,
    dashboard: false,
    logger: false,
    flood: { enabled: false },
    // Sub-second heartbeats in tests need a sweep faster than the 5s default.
    heartbeatTickMs: 50,
    security: {
      uniformFailureMs: 5,
      connectionBurst: 500,
      connectionRefillPerSec: 100,
      maxConnectionsPerIp: 200,
    },
  });
  await hub.start();
});

after(async () => {
  await hub?.stop();
  if (storeDir) rmSync(storeDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Heartbeats: the dead-man's switch                                   */
/* ------------------------------------------------------------------ */

test('duration strings parse the way people write them', () => {
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('15m'), 900_000);
  assert.equal(parseDuration('24h'), 86_400_000);
  assert.equal(parseDuration('7d'), 604_800_000);
  assert.equal(parseDuration(5000), 5000);
  assert.throws(() => parseDuration('soon'), /invalid duration/);
  assert.equal(parseDuration(0), 0, 'zero grace is legitimate');
  assert.throws(() => parseDuration(-1), /invalid duration/);
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(90 * 60_000), '1.5h');
});

test('a missed check-in raises an alert, and returning clears it', async () => {
  const device = makeClient('watcher');
  await device.pair(hub.createPairingCode({ role: 'oncall' }).code);
  await once(device, 'ready');

  const seen = [];
  device.on('notification', (n) => seen.push(n));
  const resolves = [];
  device.on('resolve', (r) => resolves.push(r));

  // A job expected every 300ms with no grace: silence becomes an alert fast.
  hub.expect('nightly-backup', {
    every: 300,
    grace: 0,
    severity: 'critical',
    description: 'Nightly database backup',
  });

  const missed = await onHub('heartbeat:missed');
  assert.equal(missed.heartbeat.name, 'nightly-backup');

  await new Promise((r) => setTimeout(r, 200));
  const alert = seen.find((n) => n.title.includes('No check-in'));
  assert.ok(alert, 'the hub alerted about the silence');
  assert.equal(alert.severity, 'critical');
  assert.match(alert.body, /Nightly database backup/);
  assert.equal(alert.resolveKey, 'heartbeat:nightly-backup');

  // Checking in again should clear the alert from every screen.
  assert.equal(hub.checkIn('nightly-backup'), true);
  await new Promise((r) => setTimeout(r, 200));

  assert.ok(
    resolves.some((r) => r.key === 'heartbeat:nightly-backup'),
    'devices were told to clear the alert',
  );
  assert.ok(
    seen.some((n) => n.title.includes('checking in again')),
    'recovery is announced',
  );

  hub.forget('nightly-backup');
  device.disconnect();
});

test('checking in on time never alerts', async () => {
  const watchdog = new Watchdog(
    () => assert.fail('a healthy heartbeat must not alert'),
    () => {},
    20,
  );
  watchdog.expect('healthy', { every: 200, grace: 50 });

  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 60));
    watchdog.checkIn('healthy');
  }
  await new Promise((r) => setTimeout(r, 60));
  watchdog.stop();
});

test('an unknown check-in name is reported rather than silently ignored', () => {
  assert.equal(hub.checkIn('never-registered'), false);
});

test('heartbeats survive a hub restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notifyjs-hb-'));
  const first = new Notifier({ port: 7882, storeDir: dir, dashboard: false, logger: false });
  await first.start();
  first.expect('backup', { every: '24h', grace: '1h' });
  await first.stop();

  const second = new Notifier({ port: 7882, storeDir: dir, dashboard: false, logger: false });
  await second.start();
  const restored = second.heartbeats();
  assert.equal(restored.length, 1);
  assert.equal(restored[0].name, 'backup');
  assert.equal(restored[0].every, 86_400_000);
  assert.equal(restored[0].grace, 3_600_000);
  await second.stop();
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* RemoteNotifier: closing the blind spot                              */
/* ------------------------------------------------------------------ */

test('an app sends to a hub in another process', async () => {
  const { code } = hub.createPairingCode({ role: 'admin' });
  const remote = new RemoteNotifier({
    url: `ws://127.0.0.1:${PORT}`,
    storage: memoryStorage(),
    pairingCode: code,
    name: 'remote-app',
  });

  const device = makeClient('remote-listener');
  await device.pair(hub.createPairingCode({ role: 'oncall' }).code);
  await once(device, 'ready');
  const arriving = once(device, 'notification');

  await remote.error({ title: 'from another process', channel: 'db' });
  const received = await arriving;
  assert.equal(received.title, 'from another process');

  remote.disconnect();
  device.disconnect();
});

test('keepAlive registers a heartbeat and keeps it satisfied', async () => {
  const { code } = hub.createPairingCode({ role: 'admin' });
  const remote = new RemoteNotifier({
    url: `ws://127.0.0.1:${PORT}`,
    storage: memoryStorage(),
    pairingCode: code,
    name: 'kept-alive-app',
  });

  const stop = await remote.keepAlive('service-alive', { every: 600, grace: 200 });

  let missed = false;
  const onMissed = (e) => {
    if (e.heartbeat.name === 'service-alive') missed = true;
  };
  hub.on('heartbeat:missed', onMissed);

  // While the app is running, the timer keeps the hub satisfied.
  await new Promise((r) => setTimeout(r, 1400));
  assert.equal(missed, false, 'a live app never looks dead');

  // Now simulate the process dying: stop checking in.
  stop();
  remote.disconnect();

  const event = await onHub('heartbeat:missed');
  assert.equal(event.heartbeat.name, 'service-alive');
  hub.off('heartbeat:missed', onMissed);
  hub.forget('service-alive');
});

/* ------------------------------------------------------------------ */
/* Escalation policies                                                 */
/* ------------------------------------------------------------------ */

test('a policy rings its rungs in order and stops when answered', async () => {
  const first = makeClient('rung-one');
  const second = makeClient('rung-two');
  await first.pair(hub.createPairingCode({ role: 'oncall' }).code);
  await once(first, 'ready');
  await second.pair(hub.createPairingCode({ role: 'oncall' }).code);
  await once(second, 'ready');

  const firstId = hub.devices().find((d) => d.name === 'rung-one').id;
  const secondId = hub.devices().find((d) => d.name === 'rung-two').id;

  hub.upsertPolicy({
    name: 'ladder',
    steps: [
      { to: { devices: [firstId] }, ringSeconds: 1 },
      { to: { devices: [secondId] }, ringSeconds: 3 },
    ],
  });

  const rang = [];
  first.on('call', (c) => rang.push('one'));
  // Only the second rung answers, so the call must reach it.
  second.on('call', (c) => {
    rang.push('two');
    second.answerCall(c.id);
  });

  const result = await hub.call({ message: 'ladder test', policy: 'ladder' });
  assert.equal(result.outcome, 'answered');
  assert.equal(result.deviceName, 'rung-two');
  assert.deepEqual(rang, ['one', 'two'], 'rungs ring in order');

  first.disconnect();
  second.disconnect();
  await new Promise((r) => setTimeout(r, 200));
});

test('an unknown policy fails loudly instead of paging nobody', async () => {
  await assert.rejects(
    () => hub.call({ message: 'nope', policy: 'does-not-exist' }),
    /unknown escalation policy/,
  );
});

/* ------------------------------------------------------------------ */
/* Resolve                                                             */
/* ------------------------------------------------------------------ */

test('resolving clears the alert on every connected device', async () => {
  const device = makeClient('resolver');
  await device.pair(hub.createPairingCode({ role: 'viewer' }).code);
  await once(device, 'ready');

  const cleared = [];
  device.on('resolve', (r) => cleared.push(r));

  await hub.error({ title: 'disk full', channel: 'db', resolveKey: 'disk:/var' });
  await new Promise((r) => setTimeout(r, 150));

  const ids = await hub.resolve('disk:/var');
  assert.equal(ids.length, 1);
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(cleared.length, 1);
  assert.deepEqual(cleared[0].ids, ids);

  // Resolving twice is a no-op rather than a second broadcast.
  assert.deepEqual(await hub.resolve('disk:/var'), []);
  device.disconnect();
});

/* ------------------------------------------------------------------ */
/* Snooze                                                              */
/* ------------------------------------------------------------------ */

test('a snoozed device is quiet, except for critical alerts', async () => {
  const device = makeClient('sleepy');
  await device.pair(hub.createPairingCode({ role: 'oncall' }).code);
  await once(device, 'ready');

  const seen = [];
  device.on('notification', (n) => seen.push(n.title));

  device.snooze(60_000);
  await new Promise((r) => setTimeout(r, 200));

  await hub.error({ title: 'suppressed', channel: 'db' });
  await hub.critical({ title: 'still urgent', channel: 'db' });
  await new Promise((r) => setTimeout(r, 250));

  assert.deepEqual(seen, ['still urgent'], 'only the critical alert got through');

  device.unsnooze();
  await new Promise((r) => setTimeout(r, 200));
  await hub.error({ title: 'awake again', channel: 'db' });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(seen.includes('awake again'));

  device.disconnect();
});

/* ------------------------------------------------------------------ */
/* Metrics                                                             */
/* ------------------------------------------------------------------ */

test('metrics render as Prometheus text and leak no alert content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notifyjs-metrics-'));
  const m = new Notifier({ port: 7883, storeDir: dir, dashboard: false, logger: false });
  await m.start();
  await m.error({ title: 'super-secret-database-password-leak', channel: 'db' });

  const res = await fetch('http://127.0.0.1:7883/metrics');
  const text = await res.text();

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/plain/);
  assert.match(text, /notifyjs_notifications_total\{severity="error"\} 1/);
  assert.match(text, /notifyjs_uptime_seconds \d+/);
  assert.match(text, /notifyjs_devices 0/);
  assert.ok(!text.includes('super-secret'), 'alert content never appears in metrics');

  await m.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('a metrics token is enforced when one is set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notifyjs-mtok-'));
  const m = new Notifier({
    port: 7884,
    storeDir: dir,
    dashboard: false,
    logger: false,
    metricsToken: 'sekret',
  });
  await m.start();

  assert.equal((await fetch('http://127.0.0.1:7884/metrics')).status, 401);
  const ok = await fetch('http://127.0.0.1:7884/metrics', {
    headers: { authorization: 'Bearer sekret' },
  });
  assert.equal(ok.status, 200);

  await m.stop();
  rmSync(dir, { recursive: true, force: true });
});
