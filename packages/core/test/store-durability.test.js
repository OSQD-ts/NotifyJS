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
