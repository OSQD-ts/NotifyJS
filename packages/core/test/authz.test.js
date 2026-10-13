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

/**
 * Chosen by the OS, not by this file. Fixed ports made the suite fail in
 * bursts whenever a port was still held from an earlier run - every test in
 * the file at once, for a reason that had nothing to do with the code.
 */
let PORT = 0;
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
    port: 0,
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
  PORT = Number(new URL(hub.url).port);
});

after(async () => {
  await hub?.stop();
  if (storeDir) rmSync(storeDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* reading the log                                                     */
/* ------------------------------------------------------------------ */

test('a role the embedding app builds is validated like one off the wire', async () => {
  // `upsertRole` wrote whatever it was handed straight into the store, while the
  // wire path sanitized first. `upsertRole(0)` and `upsertRole('viewer')` both
  // produced a role whose name persisted as the string "undefined", and
  // `channels: 'not-a-list'` - the shape another test proves cannot reach the store
  // from a device - reached it from here. A `minSeverity` typo was worse than
  // useless: it ranks below `debug`, so a role meant to filter saw everything.
  const dir = mkdtempSync(join(tmpdir(), 'notifyjs-localrole-'));
  const hub = new Notifier({ port: 0, storeDir: dir, dashboard: false, logger: false });
  await hub.start();
  try {
    const before = hub.roles().length;
    for (const bad of [0, true, '', [], {}, 'viewer', { name: '' }, { name: '__proto__', channels: ['*'] }]) {
      assert.throws(() => hub.upsertRole(bad), /needs a name|cannot be used as a role name/, JSON.stringify(bad));
    }
    for (const bad of [
      { name: 'nochan' },
      { name: 'badchan', channels: 'not-a-list' },
      { name: 'emptychan', channels: [] },
    ]) {
      assert.throws(() => hub.upsertRole(bad), /at least one channel pattern/, JSON.stringify(bad));
    }
    // A capability that is not one can only be a typo from here, and a dropped
    // `notify.recieve` is a role that receives nothing.
    assert.throws(
      () => hub.upsertRole({ name: 'typo', channels: ['*'], capabilities: ['notify.recieve'] }),
      /unknown capability "notify.recieve"/,
    );
    assert.equal(hub.roles().length, before, 'none of it reached the store');
    assert.ok(
      !hub.roles().some((r) => typeof r.name !== 'string' || r.name === '' || r.name === 'undefined'),
      'and nothing nameless is listed',
    );

    // The shape the README documents still works, unchanged, including the parts
    // `sanitizeRole` carries across rather than dropping.
    hub.upsertRole({
      name: 'night-oncall',
      channels: ['db.*', 'payments', '!db.debug'],
      minSeverity: 'error',
      capabilities: ['notify.receive', 'notify.ack', 'call.receive'],
      quietHours: { start: 1, end: 7 },
    });
    const made = hub.roles().find((r) => r.name === 'night-oncall');
    assert.deepEqual(made.channels, ['db.*', 'payments', '!db.debug']);
    assert.equal(made.minSeverity, 'error');
    assert.deepEqual(made.capabilities, ['notify.receive', 'notify.ack', 'call.receive']);
    assert.deepEqual(made.quietHours, { start: 1, end: 7 });

    // And a `minSeverity` that is not one settles on `info` rather than below
    // `debug`, which is the narrower of the two and what the wire has always done.
    hub.upsertRole({ name: 'typo-sev', channels: ['*'], minSeverity: 'criticial' });
    assert.equal(hub.roles().find((r) => r.name === 'typo-sev').minSeverity, 'info');
  } finally {
    await hub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test('a role editor cannot rewrite a role that holds more than it does', async () => {
  hub.upsertRole({
    name: 'role-editor',
    channels: ['*'],
    minSeverity: 'info',
    capabilities: ['notify.receive', 'roles.manage'],
  });

  const { client } = await joinAs('role-editor', 'role-editor-rewriter');
  try {
    // Saving the admin role's description, with the role sent back whole.
    // Stripping used to turn that into a role with no capabilities at all.
    await assert.rejects(
      client.admin('roles.upsert', {
        name: 'admin',
        description: 'renamed',
        channels: ['*'],
        minSeverity: 'info',
        capabilities: ['admin'],
      }),
      /capabilities you do not hold/,
    );
  } finally {
    client.disconnect();
  }

  const admin = hub.roles().find((r) => r.name === 'admin');
  assert.deepEqual(admin.capabilities, ['admin'], 'the admin role keeps its authority');
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

test('a receiving-only role cannot enumerate the hub', async () => {
  // `notify.receive` is the capability the RBAC module singles out as freely
  // grantable, because it "only decides whether a device is on the receiving end of
  // something". Three list operations were gated on it, so a stock viewer could read
  // every role with its channels and capabilities, every escalation policy - which
  // carries device ids - and the complete inventory of monitored jobs with their
  // descriptions.
  const { client } = await joinAs('viewer', 'nosy-viewer');

  for (const op of ['roles.list', 'policies.list', 'heartbeats.list']) {
    await assert.rejects(() => client.admin(op), /forbidden/, `${op} is refused`);
  }

  // And it can still do what a viewer is for.
  const history = await client.admin('history');
  assert.ok(Array.isArray(history.notifications), 'reading its own feed still works');

  client.disconnect();
});

test('whoever edits roles can still read them', async () => {
  // `roles.list` is the one operation two capabilities legitimately need: a role
  // editor has to see what it is editing, and whoever mints a pairing code has to
  // pick the role it points at.
  hub.upsertRole({
    name: 'code-minter',
    channels: ['*'],
    minSeverity: 'info',
    capabilities: ['notify.receive', 'devices.manage'],
  });

  for (const role of ['role-editor', 'code-minter']) {
    if (role === 'role-editor') {
      hub.upsertRole({
        name: 'role-editor',
        channels: ['*'],
        minSeverity: 'info',
        capabilities: ['notify.receive', 'roles.manage'],
      });
    }
    const { client } = await joinAs(role, `${role}-reader`);
    const { roles } = await client.admin('roles.list');
    assert.ok(roles.length > 0, `${role} can read the roles`);
    client.disconnect();
  }
});
