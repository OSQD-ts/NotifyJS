import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

import { Notifier } from '../dist/index.js';
import { SourceManager, memoryStorage, defaultPreferences, normalizePreferences } from '@osqd/notifyjs-protocol';
import { nodeCrypto } from '@osqd/notifyjs-protocol/node';

/** Two independent hubs, as a person with a home server and a work one would have. */
let home;
let work;
const dirs = [];

function hub(port, name) {
  const dir = mkdtempSync(join(tmpdir(), 'notifyjs-src-'));
  dirs.push(dir);
  return new Notifier({
    port,
    storeDir: dir,
    dashboard: false,
    logger: false,
    name,
    security: { connectionBurst: 500, connectionRefillPerSec: 100, maxConnectionsPerIp: 200 },
  });
}

function manager(storage = memoryStorage(), minSeverity = 'debug') {
  return new SourceManager({
    storage,
    crypto: nodeCrypto,
    createSocket: (url) => new WebSocket(url),
    platform: 'node-test',
    deviceName: () => 'my-phone',
    minSeverity: () => minSeverity,
  });
}

before(async () => {
  home = hub(7970, 'Home Server');
  work = hub(7971, 'Work Hub');
  await home.start();
  await work.start();
});

after(async () => {
  await home?.stop();
  await work?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test('one device subscribes to two hubs and sees a merged feed', async () => {
  const sources = manager();
  await sources.load();

  const received = [];
  sources.on('notification', (n) => received.push(n));

  await sources.add({ url: 'ws://127.0.0.1:7970', code: home.createPairingCode({ role: 'oncall' }).code });
  await sources.add({ url: 'ws://127.0.0.1:7971', code: work.createPairingCode({ role: 'viewer' }).code });

  const listed = sources.list();
  assert.equal(listed.length, 2);
  // The hub's own name replaces the host once it introduces itself.
  assert.deepEqual(listed.map((s) => s.label).sort(), ['Home Server', 'Work Hub']);
  assert.ok(listed.every((s) => s.status === 'ready' && s.paired));

  await home.error({ title: 'boiler offline', channel: 'house' });
  await work.error({ title: 'build broken', channel: 'ci' });
  await new Promise((r) => setTimeout(r, 400));

  assert.equal(received.length, 2);
  const byLabel = Object.fromEntries(received.map((r) => [r.sourceLabel, r.notification.title]));
  assert.deepEqual(byLabel, { 'Home Server': 'boiler offline', 'Work Hub': 'build broken' });

  // Each hub sees a separate device; they know nothing of each other.
  assert.equal(home.devices().length, 1);
  assert.equal(work.devices().length, 1);
  assert.notEqual(home.devices()[0].publicKey, work.devices()[0].publicKey);

  sources.disconnectAll();
});

test('each source keeps its own identity across a restart', async () => {
  const storage = memoryStorage();
  const first = manager(storage);
  await first.load();
  await first.add({ url: 'ws://127.0.0.1:7970', code: home.createPairingCode({ role: 'oncall' }).code });
  const deviceCount = home.devices().length;
  first.disconnectAll();

  // A fresh manager over the same storage, as if the app were reopened.
  const second = manager(storage);
  await second.load();
  await new Promise((r) => setTimeout(r, 600));

  const listed = second.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, 'ready', 'reconnected without re-pairing');
  assert.equal(home.devices().length, deviceCount, 'no new device was enrolled');
  second.disconnectAll();
});

test('a disabled source stays paired but goes quiet', async () => {
  const sources = manager();
  await sources.load();
  const added = await sources.add({
    url: 'ws://127.0.0.1:7971',
    code: work.createPairingCode({ role: 'viewer' }).code,
  });

  const seen = [];
  sources.on('notification', (n) => seen.push(n));

  await sources.setEnabled(added.id, false);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(sources.list()[0].status, 'idle');

  await work.info({ title: 'while muted', channel: 'ci' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(seen.length, 0, 'a muted source delivers nothing');

  await sources.setEnabled(added.id, true);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(sources.list()[0].status, 'ready');
  assert.equal(sources.list()[0].paired, true, 'it never needed re-pairing');
  sources.disconnectAll();
});

test('removing a source discards its identity', async () => {
  const sources = manager();
  await sources.load();
  const added = await sources.add({
    url: 'ws://127.0.0.1:7970',
    code: home.createPairingCode({ role: 'oncall' }).code,
  });

  await sources.remove(added.id);
  assert.equal(sources.list().length, 0);

  // Re-adding must mint a new identity rather than resurrect the old one.
  const again = await sources.add({
    url: 'ws://127.0.0.1:7970',
    code: home.createPairingCode({ role: 'oncall' }).code,
  });
  assert.notEqual(again.id, added.id);
  sources.disconnectAll();
});

test('the same hub cannot be added twice', async () => {
  const sources = manager();
  await sources.load();
  await sources.add({ url: 'ws://127.0.0.1:7970', code: home.createPairingCode({ role: 'oncall' }).code });

  await assert.rejects(
    () => sources.add({ url: 'ws://127.0.0.1:7970', code: home.createPairingCode({ role: 'oncall' }).code }),
    /already subscribed/,
  );
  sources.disconnectAll();
});

test('a failed pairing leaves no half-added source behind', async () => {
  const sources = manager();
  await sources.load();

  await assert.rejects(
    () => sources.add({ url: 'ws://127.0.0.1:7970', code: 'AAAA-AAAA-AAAA' }),
    /pairing failed|did not respond/i,
  );
  assert.equal(sources.list().length, 0, 'the list is unchanged after a failure');
});

test('a pairing link supplies both the hub and the code', async () => {
  const sources = manager();
  await sources.load();
  const issued = home.createPairingCode({ role: 'oncall' });

  const added = await sources.add({ link: issued.link, code: '' });
  assert.equal(added.status, 'ready');
  assert.equal(added.label, 'Home Server');
  sources.disconnectAll();
});

test("a personal severity floor narrows what a role allows, never widens it", async () => {
  const sources = manager(memoryStorage(), 'error');
  await sources.load();
  // The role would permit info and above; the person asked for error and above.
  await sources.add({ url: 'ws://127.0.0.1:7971', code: work.createPairingCode({ role: 'viewer' }).code });

  const seen = [];
  sources.on('notification', (n) => seen.push(n.notification.title));

  await work.info({ title: 'chatty', channel: 'ci' });
  await work.error({ title: 'actually broken', channel: 'ci' });
  await new Promise((r) => setTimeout(r, 400));

  assert.deepEqual(seen, ['actually broken']);
  sources.disconnectAll();
});

test('preferences fall back rather than break on bad stored data', () => {
  const base = defaultPreferences('Phone');
  assert.equal(base.minSeverity, 'debug');
  assert.equal(base.speech.rate, 1);

  const restored = normalizePreferences(
    { deviceName: '  Bedside  ', minSeverity: 'nonsense', speech: { rate: 99, repeat: 0 }, sound: 'yes' },
    'Phone',
  );
  assert.equal(restored.deviceName, 'Bedside', 'trimmed');
  assert.equal(restored.minSeverity, 'debug', 'an unknown severity falls back');
  assert.equal(restored.speech.rate, 2, 'clamped to the sane maximum');
  assert.equal(restored.speech.repeat, 1, 'clamped to the sane minimum');
  assert.equal(restored.sound, true, 'a non-boolean falls back');
  assert.deepEqual(normalizePreferences(null), defaultPreferences());
  assert.deepEqual(normalizePreferences('garbage'), defaultPreferences());
});

test('adding a source while the list is still loading does not cancel the pairing', async () => {
  const storage = memoryStorage();

  // Seed one existing subscription so load() has real work to do.
  const seed = manager(storage);
  await seed.load();
  await seed.add({ url: 'ws://127.0.0.1:7970', code: home.createPairingCode({ role: 'oncall' }).code });
  seed.disconnectAll();

  // A fresh manager, with a deep link arriving before load() finishes - which
  // is exactly what happens when a notifyjs:// link opens the app.
  const sources = manager(storage);
  const loading = sources.load();
  const adding = sources.add({
    url: 'ws://127.0.0.1:7971',
    code: work.createPairingCode({ role: 'oncall' }).code,
  });

  await Promise.all([loading, adding]);
  await new Promise((r) => setTimeout(r, 800));

  const listed = sources.list();
  assert.equal(listed.length, 2, 'both the restored and the newly added source are present');
  assert.ok(
    listed.every((s) => s.status === 'ready'),
    `both connected, got ${JSON.stringify(listed.map((s) => [s.label, s.status]))}`,
  );
  sources.disconnectAll();
});

test('a failed pairing leaves no client retrying in the background', async () => {
  const sources = manager();
  await sources.load();

  const before = home.auditLog(500).filter((e) => e.kind === 'pair.failed').length;
  await assert.rejects(() => sources.add({ url: 'ws://127.0.0.1:7970', code: 'AAAA-AAAA-AAAA' }));

  // An abandoned client with autoReconnect would keep retrying forever, which
  // shows up as a steadily climbing count of failures at the hub.
  await new Promise((r) => setTimeout(r, 1500));
  const after = home.auditLog(500).filter((e) => e.kind === 'pair.failed').length;

  assert.equal(after, before + 1, `expected one attempt, saw ${after - before}`);
});
