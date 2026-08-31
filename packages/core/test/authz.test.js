/**
 * Regressions for the authorization holes found in a security audit of the
 * hub. Each test is named for what an operator would have lost, not for the
 * function that was changed.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

import { Notifier, CallOrchestrator } from '../dist/index.js';
import { NotifyClient, memoryStorage, sanitizeRole } from '@osqd/notifyjs-protocol';
import { nodeCrypto } from '@osqd/notifyjs-protocol/node';

const PORT = 7899;
let hub;
let storeDir;

function makeClient(name) {
  return new NotifyClient({
    url: `ws://127.0.0.1:${PORT}`,
    crypto: nodeCrypto,
    storage: memoryStorage(),
    createSocket: (url) => new WebSocket(url),
    deviceName: name,
    platform: 'node-test',
  });
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

/** Pairs a fresh device into `role` and returns it once it is ready. */
async function joinAs(role, name) {
  const { code } = hub.createPairingCode({ role });
  const client = makeClient(name);
  const ready = once(client, 'ready');
  await client.pair(code);
  return { client, ready: await ready };
}

before(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'notifyjs-authz-'));
  hub = new Notifier({
    port: PORT,
    storeDir,
    dashboard: false,
    logger: false,
    defaultRingSeconds: 1,
    security: {
      uniformFailureMs: 5,
      maxFailuresBeforeBan: 1000,
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
/* reading the log                                                     */
/* ------------------------------------------------------------------ */

test('reading history does not hand a device the channels its role excludes', async () => {
  // `history` was gated on `notify.receive` and then returned the store
  // verbatim, so every receiving device could read every alert the hub had
  // ever sent - the channel patterns and minimum severity that govern
  // delivery were simply not consulted.
  hub.upsertRole({
    name: 'ops-only',
    channels: ['ops.*'],
    minSeverity: 'warning',
    capabilities: ['notify.receive'],
  });

  await hub.notify({ title: 'rotating the root password', channel: 'secrets', severity: 'error' });
  await hub.notify({ title: 'disk at 91%', channel: 'ops.disk', severity: 'warning' });
  await hub.notify({ title: 'nightly backup started', channel: 'ops.jobs', severity: 'info' });
  await hub.notify({ title: 'for the phone only', channel: 'ops.disk', severity: 'error', to: { devices: ['someone-else'] } });

  const { client } = await joinAs('ops-only', 'narrow-device');
  const { notifications } = await client.admin('history', { limit: 100 });
  const titles = notifications.map((n) => n.title);
  client.disconnect();

  assert.deepEqual(titles, ['disk at 91%'], `history leaked: ${JSON.stringify(titles)}`);
});

test('an admin still reads the whole log', async () => {
  const { client } = await joinAs('admin', 'auditor');
  const { notifications } = await client.admin('history', { limit: 100 });
  const titles = notifications.map((n) => n.title);
  client.disconnect();

  assert.ok(titles.includes('rotating the root password'), 'admin sees every channel');
  assert.ok(titles.includes('nightly backup started'), 'admin sees every severity');
});

/* ------------------------------------------------------------------ */
/* granting                                                            */
/* ------------------------------------------------------------------ */

test('managing devices is not a two-step route to admin', async () => {
  // `devices.manage` could point its own device at the admin role, or mint an
  // admin pairing code and walk in through the front door - so the capability
  // was admin with extra steps, and the least-privilege split was decorative.
  hub.upsertRole({
    name: 'device-manager',
    channels: ['*'],
    minSeverity: 'info',
    capabilities: ['notify.receive', 'devices.manage'],
  });

  const { client, ready } = await joinAs('device-manager', 'helpdesk');

  await assert.rejects(
    () => client.admin('devices.setRole', { deviceId: ready.deviceId, role: 'admin' }),
    /cannot grant/,
    'a device cannot promote itself past what it holds',
  );
  await assert.rejects(
    () => client.admin('pair.create', { role: 'admin' }),
    /cannot grant/,
    'nor mint a code that would let a new device in as admin',
  );

  // The capability it was actually given still works.
  const viewerCode = await client.admin('pair.create', { role: 'viewer' });
  assert.match(viewerCode.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

  const { devices } = await client.admin('devices.list');
  assert.ok(devices.length > 0, 'listing devices is unaffected');
  client.disconnect();
});

test('writing roles cannot mint a capability its author does not hold', async () => {
  // Blocking only `admin` was not enough: a `roles.manage` device could write
  // itself a role carrying `devices.manage`, and from there mint an admin
  // pairing code - admin in two moves rather than one.
  hub.upsertRole({
    name: 'role-editor',
    channels: ['*'],
    minSeverity: 'info',
    capabilities: ['notify.receive', 'roles.manage'],
  });

  const { client } = await joinAs('role-editor', 'role-editor-device');
  await client.admin('roles.upsert', {
    name: 'trojan',
    channels: ['*'],
    minSeverity: 'info',
    capabilities: ['notify.receive', 'devices.manage', 'admin'],
  });

  const { roles } = await client.admin('roles.list');
  const trojan = roles.find((r) => r.name === 'trojan');
  client.disconnect();

  assert.deepEqual(
    trojan.capabilities,
    ['notify.receive'],
    'the privileged capabilities its author lacks are stripped',
  );
});

test('a role editor can still hand out the capabilities that only receive', () => {
  // The rule must not be so tight that onboarding an ordinary viewer needs
  // admin, or operators will simply hand out admin.
  const receiver = sanitizeRole(
    { name: 'r', channels: ['*'], capabilities: ['notify.receive', 'notify.ack', 'call.receive'] },
    ['devices.manage'],
  );
  assert.deepEqual(receiver.capabilities, ['notify.receive', 'notify.ack', 'call.receive']);
});

test('sanitizeRole keeps its older boolean contract', () => {
  assert.deepEqual(
    sanitizeRole({ name: 'a', channels: ['*'], capabilities: ['admin', 'notify.send'] }, false)
      .capabilities,
    ['notify.send'],
  );
  assert.deepEqual(
    sanitizeRole({ name: 'b', channels: ['*'], capabilities: ['admin'] }, true).capabilities,
    ['admin'],
  );
});

/* ------------------------------------------------------------------ */
/* calls                                                               */
/* ------------------------------------------------------------------ */

test('a device that is not ringing cannot decline the call out from under one that is', async () => {
  // A decline that empties the rung advances the ladder at once. Unchecked,
  // any device holding a call id could clear the timer during a step's delay
  // and walk a page down to "missed" without a phone ever ringing.
  const calls = new CallOrchestrator(1, () => {});
  const target = (id) => ({ deviceId: id, deviceName: id, send: () => {} });

  const result = calls.place(
    { id: 'c9', seq: 1, ts: Date.now(), channel: 'c', severity: 'critical', from: 'x', message: 'm' },
    [
      { targets: [target('phone')], ringSeconds: 5, delaySeconds: 0 },
      { targets: [target('laptop')], ringSeconds: 5, delaySeconds: 0 },
    ],
  );

  calls.decline('c9', 'bystander');
  assert.equal(calls.activeCount, 1, 'the call is untouched');

  // The device actually being rung still decides its own leg.
  calls.decline('c9', 'phone');
  calls.answer('c9', 'laptop');
  const outcome = await result;
  assert.equal(outcome.outcome, 'answered');
  assert.equal(outcome.deviceId, 'laptop');
});

test('a role that never rings cannot answer or decline a live call', async () => {
  const oncall = await joinAs('oncall', 'real-phone');
  const viewer = await joinAs('viewer', 'nosy-tab');

  const ringing = once(oncall.client, 'call');
  const placed = hub.call({ message: 'the database is down', ringSeconds: 2 });
  const call = await ringing;

  // A viewer holds no `call.receive`, so the hub must ignore both frames even
  // though this one knows the call id.
  viewer.client.answerCall(call.id);
  viewer.client.declineCall(call.id);
  await new Promise((r) => setTimeout(r, 100));

  oncall.client.answerCall(call.id);
  const outcome = await placed;

  viewer.client.disconnect();
  oncall.client.disconnect();

  assert.equal(outcome.outcome, 'answered');
  assert.equal(outcome.deviceName, 'real-phone', 'the viewer never became part of the call');
});
