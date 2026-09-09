import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

import { Notifier } from '../dist/index.js';
import { NotifyClient, memoryStorage } from '@osqd/notifyjs-protocol';
import { nodeCrypto } from '@osqd/notifyjs-protocol/node';

let hub;
let storeDir;

function client(name, role) {
  return new NotifyClient({
    url: hub.url.replace('localhost', '127.0.0.1'),
    crypto: nodeCrypto,
    storage: memoryStorage(),
    createSocket: (url) => new WebSocket(url),
    deviceName: name,
    platform: 'node-test',
  });
}

/** Resolves with the next `ack` the hub emits, or undefined if none arrives. */
function nextAck(ms = 400) {
  return new Promise((resolve) => {
    const onAck = (e) => {
      hub.off('ack', onAck);
      clearTimeout(timer);
      resolve(e);
    };
    const timer = setTimeout(() => {
      hub.off('ack', onAck);
      resolve(undefined);
    }, ms);
    hub.on('ack', onAck);
  });
}

before(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'notifyjs-actions-'));
  hub = new Notifier({
    port: 0,
    storeDir,
    dashboard: false,
    logger: false,
    security: { connectionBurst: 500, connectionRefillPerSec: 100, maxConnectionsPerIp: 200 },
  });
  await hub.start();
});

after(async () => {
  await hub?.stop();
  rmSync(storeDir, { recursive: true, force: true });
});

test('an action the notification published is passed through', async () => {
  const c = client('presser');
  await c.pair(hub.createPairingCode({ role: 'oncall' }).code);
  await new Promise((r) => c.on('ready', r));

  const n = await hub.notify({
    title: 'Service is down',
    channel: 'db',
    actions: [{ id: 'restart', label: 'Restart' }],
  });

  const seen = nextAck();
  c.ack([n.id], { action: 'restart' });
  assert.equal((await seen)?.action, 'restart');
  c.disconnect();
});

test('an action the notification never offered is dropped', async () => {
  const c = client('liar');
  await c.pair(hub.createPairingCode({ role: 'oncall' }).code);
  await new Promise((r) => c.on('ready', r));

  const n = await hub.notify({
    title: 'Disk filling',
    channel: 'db',
    actions: [{ id: 'restart', label: 'Restart' }],
  });

  // The application is told to branch on `action`; a value it never published
  // must not reach that branch.
  const seen = nextAck();
  c.ack([n.id], { action: 'wipe-everything' });
  const event = await seen;
  assert.ok(event, 'the acknowledgement itself still lands');
  assert.equal(event.action, undefined, 'but the invented action does not');
  c.disconnect();
});

test('a notification with no actions cannot be acted on at all', async () => {
  const c = client('opportunist');
  await c.pair(hub.createPairingCode({ role: 'viewer' }).code);
  await new Promise((r) => c.on('ready', r));

  // `viewer` holds notify.ack, so this is reachable by the least-privileged
  // stock role in the project.
  const n = await hub.notify({ title: 'Just so you know', channel: 'db' });

  const seen = nextAck();
  c.ack([n.id], { action: 'restart' });
  const event = await seen;
  assert.ok(event);
  assert.equal(event.action, undefined);
  c.disconnect();
});

test('an unknown notification id carries no action either', async () => {
  const c = client('ghost');
  await c.pair(hub.createPairingCode({ role: 'oncall' }).code);
  await new Promise((r) => c.on('ready', r));

  const seen = nextAck();
  c.ack(['no-such-notification'], { action: 'restart' });
  const event = await seen;
  assert.ok(event);
  assert.equal(event.action, undefined);
  c.disconnect();
});

test('a rejected action is written to the audit log', async () => {
  const c = client('auditee');
  await c.pair(hub.createPairingCode({ role: 'oncall' }).code);
  await new Promise((r) => c.on('ready', r));

  const n = await hub.notify({ title: 'Audited', channel: 'db' });
  const seen = nextAck();
  c.ack([n.id], { action: 'made-up' });
  await seen;
  await new Promise((r) => setTimeout(r, 100));

  const rejected = hub.auditLog(50).filter((e) => e.kind === 'ack.action.rejected');
  assert.ok(rejected.length >= 1, 'the attempt is recorded');
  assert.equal(rejected.at(-1).detail.action, 'made-up');
  c.disconnect();
});
