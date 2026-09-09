import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

import { Notifier } from '../dist/index.js';
import { NotifyClient, PRIVILEGED_CAPABILITIES, memoryStorage } from '@osqd/notifyjs-protocol';
import { nodeCrypto } from '@osqd/notifyjs-protocol/node';

let hub;
let off;
let storeDir;
let offDir;

function connect(target, role) {
  const c = new NotifyClient({
    url: target.url.replace('localhost', '127.0.0.1'),
    crypto: nodeCrypto,
    storage: memoryStorage(),
    createSocket: (url) => new WebSocket(url),
    deviceName: `d${Math.random().toString(36).slice(2, 8)}`,
    platform: 'node-test',
  });
  return c
    .pair(target.createPairingCode({ role }).code)
    .then(() => new Promise((r) => c.on('ready', r)))
    .then(() => c);
}

/** The next `action` or `ack` the hub emits, or undefined if none arrives. */
function next(target, event, ms = 400) {
  return new Promise((resolve) => {
    const on = (e) => {
      target.off(event, on);
      clearTimeout(timer);
      resolve(e);
    };
    const timer = setTimeout(() => {
      target.off(event, on);
      resolve(undefined);
    }, ms);
    target.on(event, on);
  });
}

const withButton = (title) => ({
  title,
  channel: 'db',
  actions: [{ id: 'restart', label: 'Restart' }],
});

before(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'notifyjs-act-'));
  hub = new Notifier({
    port: 0,
    storeDir,
    dashboard: false,
    logger: false,
    actions: { enabled: true },
    security: { connectionBurst: 500, connectionRefillPerSec: 100, maxConnectionsPerIp: 200 },
  });
  await hub.start();

  // A second hub left at the default, to show the feature is off until asked for.
  offDir = mkdtempSync(join(tmpdir(), 'notifyjs-act-off-'));
  off = new Notifier({
    port: 0,
    storeDir: offDir,
    dashboard: false,
    logger: false,
    security: { connectionBurst: 500, connectionRefillPerSec: 100, maxConnectionsPerIp: 200 },
  });
  await off.start();
});

after(async () => {
  await hub?.stop();
  await off?.stop();
  rmSync(storeDir, { recursive: true, force: true });
  rmSync(offDir, { recursive: true, force: true });
});

test('a published action, from a role that may act, reaches the application', async () => {
  const c = await connect(hub, 'admin');
  const n = await hub.notify(withButton('Service is down'));

  const seen = next(hub, 'action');
  c.ack([n.id], { action: 'restart' });
  const event = await seen;

  assert.ok(event, 'the application is told');
  assert.equal(event.actionId, 'restart');
  assert.equal(event.notificationId, n.id);
  assert.ok(event.deviceId);
  c.disconnect();
});

test('the same action cannot be taken twice', async () => {
  const first = await connect(hub, 'admin');
  const second = await connect(hub, 'admin');
  const n = await hub.notify(withButton('Restart me once'));

  const taken = next(hub, 'action');
  first.ack([n.id], { action: 'restart' });
  assert.ok(await taken, 'the first press lands');

  // For an action that restarts something, two devices pressing the same
  // button is the difference between a fix and an outage.
  const again = next(hub, 'action');
  second.ack([n.id], { action: 'restart' });
  assert.equal(await again, undefined, 'the second is refused');

  const rejected = hub.auditLog(50).filter((e) => e.kind === 'ack.action.rejected');
  assert.match(rejected.at(-1).detail.reason, /already taken/);
  first.disconnect();
  second.disconnect();
});

test('a role without notify.act cannot act, only acknowledge', async () => {
  // `oncall` carries notify.ack, and the stock `viewer` does too - which is
  // exactly why acting needs its own capability.
  const c = await connect(hub, 'oncall');
  const n = await hub.notify(withButton('Not for you'));

  const acted = next(hub, 'action');
  const acked = next(hub, 'ack');
  c.ack([n.id], { action: 'restart' });

  assert.equal(await acted, undefined, 'no action reaches the application');
  const ack = await acked;
  assert.ok(ack, 'the acknowledgement itself still counts');
  assert.equal(ack.action, undefined);
  c.disconnect();
});

test('an action the notification never published is refused', async () => {
  const c = await connect(hub, 'admin');
  const n = await hub.notify(withButton('Disk filling'));

  const acted = next(hub, 'action');
  c.ack([n.id], { action: 'wipe-everything' });
  assert.equal(await acted, undefined);

  const rejected = hub.auditLog(50).filter((e) => e.kind === 'ack.action.rejected');
  assert.match(rejected.at(-1).detail.reason, /did not offer/);
  c.disconnect();
});

test('a notification with no buttons cannot be acted on', async () => {
  const c = await connect(hub, 'admin');
  const n = await hub.notify({ title: 'Just so you know', channel: 'db' });

  const acted = next(hub, 'action');
  c.ack([n.id], { action: 'restart' });
  assert.equal(await acted, undefined);
  c.disconnect();
});

test('an unknown notification id is refused', async () => {
  const c = await connect(hub, 'admin');
  const acted = next(hub, 'action');
  c.ack(['no-such-notification'], { action: 'restart' });
  assert.equal(await acted, undefined);
  c.disconnect();
});

test('the feature is off until a hub asks for it', async () => {
  const c = await connect(off, 'admin');
  const n = await off.notify(withButton('Buttons, but disabled'));

  const acted = next(off, 'action');
  c.ack([n.id], { action: 'restart' });
  assert.equal(await acted, undefined, 'a hub that never enabled actions has none');

  const rejected = off.auditLog(50).filter((e) => e.kind === 'ack.action.rejected');
  assert.match(rejected.at(-1).detail.reason, /not enabled/);
  c.disconnect();
});

test('a taken action is recorded on the notification, so a restart cannot undo it', async () => {
  const c = await connect(hub, 'admin');
  const n = await hub.notify(withButton('Recorded'));
  const taken = next(hub, 'action');
  c.ack([n.id], { action: 'restart' });
  await taken;
  c.disconnect();

  // Held in history rather than in memory: otherwise a hub that restarted
  // would offer the same action again.
  const stored = hub.history().find((entry) => entry.id === n.id);
  assert.ok(stored.actionTaken, 'the notification carries it');
  assert.equal(stored.actionTaken.id, 'restart');
  assert.ok(stored.actionTaken.at > 0);
});

test('granting notify.act is treated as an escalation', () => {
  // A role that can act reaches into whatever the application does about an
  // alert, so handing it out is the same kind of escalation as handing out the
  // ability to raise one - and `assertMayGrantRole` refuses a privileged
  // capability the granter does not hold.
  assert.ok(
    PRIVILEGED_CAPABILITIES.includes('notify.act'),
    'notify.act cannot be granted by somebody who does not hold it',
  );
  // And no stock role carries it, so enabling actions grants nobody anything
  // until an operator says so.
  for (const role of hub.roles()) {
    if (role.name === 'admin') continue;
    assert.ok(!role.capabilities.includes('notify.act'), `${role.name} does not act by default`);
  }
});
