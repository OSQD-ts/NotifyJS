import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Notifier, exportStore, importStore, isBackup, backupSecrets } from '../dist/index.js';

/** A hub with something worth losing: devices, a token, a VAPID key. */
async function populated(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const hub = new Notifier({
    port: 0,
    storeDir: dir,
    dashboard: false,
    logger: false,
    ingest: { enabled: true },
  });
  await hub.start();
  hub.createIngestToken({ role: 'admin', label: 'ci' });
  hub.createPairingCode({ role: 'oncall' });
  await hub.notify({ title: 'something happened', channel: 'db' });
  return { hub, dir };
}

test('a backup carries the identity a hub cannot be rebuilt without', async () => {
  const { hub, dir } = await populated('notifyjs-bk-');
  const serverId = hub.serverId;
  await hub.stop();

  const doc = exportStore(dir);
  assert.equal(doc.notifyjs, 'backup');
  assert.equal(doc.store.serverId, serverId, 'the serverId every device signs against');
  assert.ok(Object.keys(doc.store.roles).length > 0, 'roles');
  assert.ok(Object.keys(doc.store.ingestTokens).length === 1, 'publishing tokens');

  // Without history unless asked: it is the bulk of the bytes and none of the
  // identity.
  assert.equal(doc.history, undefined);

  const withHistory = exportStore(dir, { history: true });
  assert.ok(withHistory.history.length >= 1, 'history when asked for');

  rmSync(dir, { recursive: true, force: true });
});

test('a restored hub keeps its identity, so devices do not need re-pairing', async () => {
  const { hub, dir } = await populated('notifyjs-bk2-');
  const serverId = hub.serverId;
  const before = hub.devices().length;
  // Stopped first: the hub writes its document on a timer, so exporting
  // underneath a live one reads whatever was last flushed.
  await hub.stop();
  const doc = exportStore(dir, { history: true });

  const fresh = mkdtempSync(join(tmpdir(), 'notifyjs-restore-'));
  rmSync(fresh, { recursive: true, force: true });
  const counts = importStore(fresh, doc);
  assert.ok(counts.restoredHistory >= 1);

  const restored = new Notifier({ port: 0, storeDir: fresh, dashboard: false, logger: false });
  await restored.start();
  // The whole point: a new serverId is a hub every paired device fails to
  // authenticate against at once.
  assert.equal(restored.serverId, serverId, 'the identity survived the move');
  assert.equal(restored.devices().length, before);
  assert.equal(restored.ingestTokens().length, 1, 'tokens came across');
  await restored.stop();

  rmSync(dir, { recursive: true, force: true });
  rmSync(fresh, { recursive: true, force: true });
});

test('restoring over an existing store is refused unless forced', async () => {
  const { hub, dir } = await populated('notifyjs-bk3-');
  await hub.stop();
  const doc = exportStore(dir);

  assert.throws(() => importStore(dir, doc), /already exists/);
  // Forcing is allowed, because replacing a store is exactly what a restore is.
  assert.doesNotThrow(() => importStore(dir, doc, { force: true }));

  rmSync(dir, { recursive: true, force: true });
});

test('the restored files are not world-readable', async () => {
  const { hub, dir } = await populated('notifyjs-bk4-');
  await hub.stop();
  const doc = exportStore(dir, { history: true });

  const fresh = mkdtempSync(join(tmpdir(), 'notifyjs-perm-'));
  rmSync(fresh, { recursive: true, force: true });
  importStore(fresh, doc);

  // The document holds the VAPID private key and every credential hash.
  const mode = statSync(join(fresh, 'store.json')).mode & 0o777;
  assert.equal(mode, 0o600, 'the store is owner-only');

  rmSync(dir, { recursive: true, force: true });
  rmSync(fresh, { recursive: true, force: true });
});

test('anything that is not a backup is refused, and so is a newer one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notifyjs-bk5-'));
  assert.equal(isBackup({ hello: 'world' }), false);
  assert.equal(isBackup(null), false);
  assert.throws(() => importStore(dir, { hello: 'world' }), /not a NotifyJS backup/);

  // A file written by a later release must not be half-read by this one.
  const future = { notifyjs: 'backup', version: 99, createdAt: 0, store: {} };
  assert.throws(() => importStore(dir, future), /version 99/);

  rmSync(dir, { recursive: true, force: true });
});

test('exporting a directory with no store says so', () => {
  const empty = mkdtempSync(join(tmpdir(), 'notifyjs-bk6-'));
  assert.throws(() => exportStore(empty), /no store to export/);
  rmSync(empty, { recursive: true, force: true });
});

test('an operator is told what the file contains', () => {
  // A pure reading of the document, so it does not depend on whether this
  // particular hub has minted a VAPID key yet - that happens on first use,
  // when a device authenticates, not at startup.
  const withSecrets = backupSecrets({
    notifyjs: 'backup',
    version: 1,
    createdAt: 0,
    store: { vapid: { publicKey: 'p', privateKey: 'k' }, ingestTokens: { a: {} } },
  });
  assert.ok(withSecrets.some((s) => /VAPID/.test(s)), 'the VAPID private key is named');
  assert.ok(withSecrets.some((s) => /publishing token/.test(s)), 'token hashes are named');
  assert.ok(withSecrets.some((s) => /serverId/.test(s)));

  // A hub that has neither still has an identity worth protecting.
  const bare = backupSecrets({ notifyjs: 'backup', version: 1, createdAt: 0, store: {} });
  assert.equal(bare.length, 1);
  assert.match(bare[0], /serverId/);
});
