import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../dist/store.js';

const limits = { history: 100, audit: 100 };
let counter = 0;
const serverId = () => `server-${(counter += 1)}`;

const device = (id) => ({
  id,
  name: id,
  role: 'oncall',
  status: 'active',
  publicKey: 'k',
  ackedSeq: 0,
  lastSeenAt: Date.now(),
  createdAt: Date.now(),
});

test('a store that cannot be written says so, once, and says when it recovers', () => {
  // Every write in here refuses to take the process down over a failure, which is
  // right for a pager - and it left nobody to tell. A hub on a full or read-only
  // filesystem went on pairing devices and delivering alerts while none of it was
  // being saved, reporting itself perfectly healthy, and a restart then rolled it
  // back to whenever the disk broke.
  const dir = mkdtempSync(join(tmpdir(), 'notifyjs-persist-'));
  try {
    const seen = [];
    const store = new Store(dir, limits, serverId, (writable, trouble) =>
      seen.push({ writable, file: trouble?.file, message: trouble?.error?.message }),
    );
    store.putDevice(device('first'));
    store.flush();
    assert.deepEqual(seen, [], 'nothing to report while it is working');
    assert.equal(store.persistence.writable, true);

    chmodSync(dir, 0o500);
    store.putDevice(device('second'));
    store.flush();
    assert.equal(store.persistence.writable, false, 'the gauge /metrics scrapes');
    assert.equal(seen.length, 1, 'reported once');
    assert.equal(seen[0].writable, false);
    assert.ok(seen[0].message, 'with the reason the filesystem gave');
    assert.ok(seen[0].file, 'and which file could not be written');

    // A read-only mount fails on every drain. The operator is told once, not every
    // few seconds, so only the edges are reported.
    store.putDevice(device('third'));
    store.flush();
    store.flush();
    assert.equal(seen.length, 1, 'still once');
    assert.ok(store.persistence.failures >= 2, 'while the counter keeps counting');

    // And the recovery is announced, because a hub that has caught up is news too.
    chmodSync(dir, 0o700);
    store.flush();
    assert.equal(store.persistence.writable, true);
    assert.equal(seen.length, 2);
    assert.equal(seen[1].writable, true);

    // Everything held back while the disk was gone is on disk now.
    const written = readFileSync(join(dir, 'store.json'), 'utf8');
    for (const id of ['first', 'second', 'third']) {
      assert.ok(written.includes(id), `${id} was written once the disk came back`);
    }
    store.close();
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one unwritable file does not make the report alternate', () => {
  // The document and the two logs are written separately and fail separately, so a
  // single flag for "the store" was wrong in both directions: a history log left
  // unwritable by a permission change - while the directory and `store.json` were
  // fine - had the flag going failing, recovered, failing, recovered on every
  // drain. Two log lines a second at the moment an operator is reading them, and a
  // gauge that read healthy at rest while a log was still being dropped.
  const dir = mkdtempSync(join(tmpdir(), 'notifyjs-onefile-'));
  const log = join(dir, 'history.jsonl');
  try {
    const seen = [];
    const store = new Store(dir, limits, serverId, (writable) => seen.push(writable));
    store.pushHistory({ seq: 1, ts: Date.now(), title: 'seed', severity: 'error' });
    store.putDevice(device('first'));
    store.flush();
    assert.deepEqual(seen, [], 'a healthy store reports nothing');

    chmodSync(log, 0o400);
    for (let i = 2; i < 6; i += 1) {
      store.pushHistory({ seq: i, ts: Date.now(), title: `t${i}`, severity: 'error' });
      store.putDevice(device(`later-${i}`));
      store.flush();
    }
    assert.deepEqual(seen, [false], 'one report across four drains');
    assert.equal(store.persistence.writable, false, 'and it does not read healthy at rest');

    // The document beside it kept being written throughout, which is the whole
    // reason the flag flapped.
    assert.ok(readFileSync(join(dir, 'store.json'), 'utf8').includes('later-5'));

    chmodSync(log, 0o600);
    store.pushHistory({ seq: 6, ts: Date.now(), title: 'after', severity: 'error' });
    store.flush();
    assert.deepEqual(seen, [false, true], 'and the recovery is reported once');
    store.close();
  } finally {
    chmodSync(log, 0o600);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a write that fails does not take the process down, and is retried', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notifyjs-durable-'));
  try {
    const store = new Store(dir, limits, serverId);
    store.putDevice(device('first'));
    store.flush();
    assert.ok(readFileSync(join(dir, 'store.json'), 'utf8').includes('first'));

    // A full disk, a read-only mount, permissions changed underneath a running
    // hub. This flush is reached from a timer, so throwing here used to raise
    // an uncaught exception and kill the hub outright.
    chmodSync(dir, 0o500);
    store.putDevice(device('second'));
    assert.doesNotThrow(() => store.flush(), 'a failed write is survivable');

    // And the change must not be silently dropped: `dirty` used to be cleared
    // before the write, so a failure meant the store reported itself clean
    // while memory and disk disagreed.
    chmodSync(dir, 0o700);
    store.flush();

    const written = readFileSync(join(dir, 'store.json'), 'utf8');
    assert.ok(written.includes('second'), 'the pending change reached disk once it could');
    assert.ok(written.includes('first'), 'and the earlier one survived');
    store.close();
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed write leaves the previous store intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notifyjs-durable2-'));
  try {
    const store = new Store(dir, limits, serverId);
    store.putDevice(device('keeper'));
    store.flush();
    const before = readFileSync(join(dir, 'store.json'), 'utf8');

    chmodSync(dir, 0o500);
    store.putDevice(device('doomed'));
    store.flush();

    chmodSync(dir, 0o700);
    // Write-then-rename: a failure must not leave a half-written document
    // where the real one was.
    assert.equal(readFileSync(join(dir, 'store.json'), 'utf8'), before);
    store.close();
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('closing does not arm a timer nothing will service', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notifyjs-durable3-'));
  try {
    const store = new Store(dir, limits, serverId);
    store.putDevice(device('last'));
    chmodSync(dir, 0o500);
    // The final write fails; close() must still return, and must not schedule
    // a retry for a store that is going away.
    assert.doesNotThrow(() => store.close());
    // Asserted, not assumed: the only check here used to be that `close()`
    // returned, which stayed true with the guard removed - and the re-armed timer
    // is unref'd, so nothing else could feel it either.
    assert.equal(store.saveTimer, undefined, 'no timer is left armed');
    assert.equal(store.closed, true, 'and the store knows it is closed');
    // A write after closing must not arm one either.
    store.putDevice(device('after'));
    assert.equal(store.saveTimer, undefined, 'and a later write does not arm one');
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the serverId is written on first boot even with no devices', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notifyjs-durable4-'));
  try {
    const store = new Store(dir, limits, serverId);
    store.close();
    // Letting this be regenerated on the next boot invalidates every pairing.
    assert.ok(existsSync(join(dir, 'store.json')));
    const reopened = new Store(dir, limits, serverId);
    assert.equal(reopened.serverId, store.serverId);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
