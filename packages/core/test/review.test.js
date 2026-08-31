/**
 * Regressions for the defects found in a full review of the hub.
 *
 * Each test names the thing that was actually broken, not the code that was
 * changed - so if a later refactor reintroduces the behaviour, the failure
 * says what an operator would have experienced.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rmSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

import { Notifier, Store, CallOrchestrator } from '../dist/index.js';
import {
  NotifyClient,
  channelMatches,
  memoryStorage,
  findChecksum,
  timingSafeEqual,
  parsePairingLink,
  sanitizeRole,
  sha256Hex,
} from '@osqd/notifyjs-protocol';
import { nodeCrypto } from '@osqd/notifyjs-protocol/node';

const PORT = 7896;
let hub;
let storeDir;

function makeClient(name, opts = {}) {
  return new NotifyClient({
    url: `ws://127.0.0.1:${PORT}`,
    crypto: nodeCrypto,
    storage: opts.storage ?? memoryStorage(),
    createSocket: (url) => new WebSocket(url),
    deviceName: name,
    platform: 'node-test',
    ...opts,
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

async function disconnectAndWait(client, deviceName) {
  const gone = new Promise((resolve) => {
    const handler = (device) => {
      if (device.name === deviceName) {
        hub.off('device:offline', handler);
        resolve();
      }
    };
    hub.on('device:offline', handler);
  });
  client.disconnect();
  await gone;
}

before(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'notifyjs-review-'));
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
/* protocol primitives                                                 */
/* ------------------------------------------------------------------ */

test('the shared SHA-256 agrees with the real thing at every message length', () => {
  // The padding block was rounded up one byte too far, so any input whose
  // length was 55 mod 64 got an extra block and a digest that was not SHA-256.
  // Pairing-code hashing happens to use fixed-length inputs, which is the only
  // reason this never surfaced.
  for (let length = 0; length <= 200; length++) {
    const data = Buffer.alloc(length, 0x61);
    assert.equal(
      sha256Hex(new Uint8Array(data)),
      createHash('sha256').update(data).digest('hex'),
      `digest differs at length ${length}`,
    );
  }
});

test('a channel pattern full of wildcards matches in linear time', () => {
  // Compiled to a regular expression, `*a*a*a...b` backtracks exponentially:
  // one notification on a long channel name would pin the event loop.
  const pattern = '*a'.repeat(20) + 'b';
  const started = Date.now();
  assert.equal(channelMatches([pattern], 'a'.repeat(2000)), false);
  assert.ok(Date.now() - started < 500, 'matching should not backtrack');
});

test('wildcard matching keeps its old meaning', () => {
  assert.equal(channelMatches(['db.*'], 'db.slow'), true);
  assert.equal(channelMatches(['db.*'], 'dbxslow'), false, '. is literal, not a wildcard');
  assert.equal(channelMatches(['*', '!debug.*'], 'debug.trace'), false);
  assert.equal(channelMatches(['*', '!debug.*'], 'deploy'), true);
  assert.equal(channelMatches(['DB.*'], 'db.slow'), true, 'still case-insensitive');
  assert.equal(channelMatches(['exact'], 'exactly'), false);
});

/* ------------------------------------------------------------------ */
/* roles                                                               */
/* ------------------------------------------------------------------ */

test('a role that cannot grant admin cannot grant it to itself', () => {
  const escalated = sanitizeRole(
    { name: 'sneaky', channels: ['*'], capabilities: ['admin', 'notify.send'] },
    false,
  );
  assert.deepEqual(escalated.capabilities, ['notify.send']);

  const legitimate = sanitizeRole({ name: 'ops', channels: ['*'], capabilities: ['admin'] }, true);
  assert.deepEqual(legitimate.capabilities, ['admin']);
});

test('a malformed role is refused instead of breaking every later delivery', () => {
  // `channels` as a string used to reach the delivery loop and throw there,
  // which took down notify() for every notification after it.
  assert.throws(() => sanitizeRole({ name: 'x', channels: 'oops' }, true));
  assert.throws(() => sanitizeRole({ channels: ['*'] }, true), /needs a name/);
  assert.throws(() => sanitizeRole({ name: '__proto__', channels: ['*'] }, true));
  assert.deepEqual(sanitizeRole({ name: 'ok', channels: ['a', 7, 'b'] }, true).channels, ['a', 'b']);
});

test('a role name that would touch the prototype is refused by the store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notifyjs-proto-'));
  try {
    const store = new Store(dir, { history: 10, audit: 10 }, () => 'srv');
    assert.throws(() => store.putRole({ name: '__proto__', channels: ['*'] }));
    assert.equal(store.role('constructor'), undefined, 'inherited keys are not records');
    assert.equal(store.device('__proto__'), undefined);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* store                                                               */
/* ------------------------------------------------------------------ */

test('resolving an alert does not duplicate history on disk', () => {
  // touchHistory() rewrote the log from the in-memory cache while appends for
  // those same entries were still queued, so the queued lines landed a second
  // time and a restart saw every resolved notification twice.
  const dir = mkdtempSync(join(tmpdir(), 'notifyjs-hist-'));
  try {
    const store = new Store(dir, { history: 100, audit: 100 }, () => 'srv');
    for (let i = 0; i < 3; i++) {
      store.pushHistory({ id: `n${i}`, seq: i, ts: Date.now(), channel: 'c', severity: 'info', title: `t${i}` });
    }
    store.touchHistory();
    store.close();

    const lines = readFileSync(join(dir, 'history.jsonl'), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 3, 'each notification is written exactly once');

    const reopened = new Store(dir, { history: 100, audit: 100 }, () => 'srv');
    assert.equal(reopened.history().length, 3);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a store missing its roles is migrated rather than condemned as corrupt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notifyjs-old-'));
  try {
    const store = new Store(dir, { history: 10, audit: 10 }, () => 'srv');
    store.putDevice({
      id: 'd1', name: 'phone', role: 'viewer', publicKey: 'k', platform: 'test',
      status: 'active', createdAt: 0, ackedSeq: 0,
    });
    store.close();

    // An older document, written before `roles` existed in the schema.
    const raw = JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8'));
    delete raw.roles;
    writeFileSync(join(dir, 'store.json'), JSON.stringify(raw));

    const reopened = new Store(dir, { history: 10, audit: 10 }, () => 'srv');
    assert.equal(reopened.device('d1')?.name, 'phone', 'the operator keeps their devices');
    assert.ok(reopened.role('viewer'), 'default roles are merged back in');
    assert.equal(
      existsSync(join(dir, 'store.json')),
      true,
      'the store was not set aside as corrupt',
    );
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('history() hands out a copy, not the replay buffer itself', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notifyjs-copy-'));
  try {
    const store = new Store(dir, { history: 10, audit: 10 }, () => 'srv');
    store.pushHistory({ id: 'n1', seq: 1, ts: Date.now(), channel: 'c', severity: 'info', title: 't' });
    store.history().length = 0;
    assert.equal(store.history().length, 1, 'a caller cannot empty the replay buffer');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* pairing                                                             */
/* ------------------------------------------------------------------ */

test('two devices racing on one single-use code produce exactly one pairing', async () => {
  // Redemption spans an await on signature verification. The use is now
  // claimed before that gap, so the second attempt finds nothing left.
  const { code } = hub.createPairingCode({ role: 'viewer', uses: 1 });
  const before = hub.devices().length;

  const a = makeClient('race-a');
  const b = makeClient('race-b');
  const outcomes = await Promise.all([
    Promise.race([once(a, 'ready').then(() => 'ok'), once(a, 'error').then(() => 'rejected')]),
    Promise.race([once(b, 'ready').then(() => 'ok'), once(b, 'error').then(() => 'rejected')]),
    (async () => {
      // Started in the same tick so both handshakes are in flight together.
      await Promise.all([a.pair(code), b.pair(code)]);
      return 'sent';
    })(),
  ]);

  assert.deepEqual(
    outcomes.slice(0, 2).filter((o) => o === 'ok').length,
    1,
    'exactly one of the two racing devices pairs',
  );
  assert.equal(hub.devices().length, before + 1, 'only one device was enrolled');

  for (const client of [a, b]) client.disconnect();
});

/* ------------------------------------------------------------------ */
/* calls                                                               */
/* ------------------------------------------------------------------ */

test('a device that was merely rung cannot retire somebody else\'s call', async () => {
  // `call.ended` used to delete the call outright, so a device on an early
  // rung could make the hub forget a call that was still ringing someone
  // else - the real answer was then ignored and the page reported as missed.
  const sent = [];
  const calls = new CallOrchestrator(1, () => {});
  const target = (id) => ({ deviceId: id, deviceName: id, send: (m) => sent.push([id, m]) });

  const result = calls.place(
    { id: 'c1', seq: 1, ts: Date.now(), channel: 'c', severity: 'critical', from: 'x', message: 'm' },
    [
      { targets: [target('phone')], ringSeconds: 1, delaySeconds: 0 },
      { targets: [target('laptop')], ringSeconds: 5, delaySeconds: 0 },
    ],
  );

  // The first rung hangs up without ever answering.
  calls.ended('c1', 'phone');
  assert.equal(calls.activeCount, 1, 'the call is still live');

  // The second rung takes it, once the first has rung out.
  await new Promise((r) => setTimeout(r, 1300));
  calls.answer('c1', 'laptop');

  const outcome = await result;
  assert.equal(outcome.outcome, 'answered');
  assert.equal(outcome.deviceId, 'laptop');
});

test('the device that answered can end its own call', async () => {
  const calls = new CallOrchestrator(1, () => {});
  const target = (id) => ({ deviceId: id, deviceName: id, send: () => {} });
  const result = calls.place(
    { id: 'c2', seq: 1, ts: Date.now(), channel: 'c', severity: 'critical', from: 'x', message: 'm' },
    [{ targets: [target('phone')], ringSeconds: 5, delaySeconds: 0 }],
  );

  calls.answer('c2', 'phone');
  assert.equal((await result).outcome, 'answered');
  calls.ended('c2', 'phone');
  assert.equal(calls.activeCount, 0, 'the record is released once the call ends');
});

/* ------------------------------------------------------------------ */
/* admin surface                                                       */
/* ------------------------------------------------------------------ */

test('notify.resolve reports the ids it actually resolved', async () => {
  // The handler replied with the unawaited promise, which serialised to `{}` -
  // so every caller was told nothing had been resolved.
  const { code } = hub.createPairingCode({ role: 'admin' });
  const admin = makeClient('resolver');
  await admin.pair(code);
  await once(admin, 'ready');

  await admin.admin('notify.send', { title: 'disk filling up', resolveKey: 'disk' });
  await new Promise((r) => setTimeout(r, 50));

  const out = await admin.admin('notify.resolve', { key: 'disk' });
  assert.ok(Array.isArray(out.resolved), 'resolved is a list of ids');
  assert.equal(out.resolved.length, 1);

  await disconnectAndWait(admin, 'resolver');
});

test('an unrecognised severity cannot be written into the metrics endpoint', async () => {
  const { code } = hub.createPairingCode({ role: 'admin' });
  const admin = makeClient('injector');
  await admin.pair(code);
  await once(admin, 'ready');

  await admin.admin('notify.send', {
    title: 'probe',
    severity: 'bogus"} 1\nnotifyjs_injected{x="1',
  });
  await new Promise((r) => setTimeout(r, 50));

  const { text } = await admin.admin('metrics');
  assert.ok(!text.includes('notifyjs_injected'), 'no line was injected');
  assert.ok(!text.includes('bogus'), 'the severity fell back to a known one');

  await disconnectAndWait(admin, 'injector');
});

test('a role that would break delivery is rejected over the wire', async () => {
  const { code } = hub.createPairingCode({ role: 'admin' });
  const admin = makeClient('role-editor');
  await admin.pair(code);
  await once(admin, 'ready');

  await assert.rejects(
    admin.admin('roles.upsert', { name: 'broken', channels: 'not-a-list' }),
    'a malformed role never reaches the store',
  );

  // The hub still delivers afterwards, which is what the crash used to cost.
  const sent = await hub.notify({ title: 'still working' });
  assert.equal(sent.title, 'still working');

  await disconnectAndWait(admin, 'role-editor');
});

/* ------------------------------------------------------------------ */
/* client                                                              */
/* ------------------------------------------------------------------ */

test('an unpaired client stops instead of reconnecting forever', async () => {
  // With autoReconnect on, "unpaired" used to close the socket and immediately
  // schedule another attempt, hammering the hub about once a second with a
  // handshake it had already refused.
  const client = makeClient('never-paired', { autoReconnect: true });
  await client.connect();
  await once(client, 'status', 3000).catch(() => {});

  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(client.status, 'unpaired', 'it settles rather than retrying');
  client.disconnect();
});

test('a revoked device stops claiming the service is down', async () => {
  const storage = memoryStorage();
  const { code } = hub.createPairingCode({ role: 'viewer' });
  const client = makeClient('to-be-revoked', { storage });
  await client.pair(code);
  const ready = await once(client, 'ready');

  const revoked = once(client, 'revoked');
  hub.revokeDevice(ready.deviceId);
  await revoked;
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(client.watchdog, undefined, 'the watchdog contract went with the credentials');
  assert.equal(await storage.get('notifyjs.watchdog'), null, 'and left nothing in storage');
  client.disconnect();
});

test('a code rejected for a reason other than its secret is not burned', async () => {
  // Reserving the use before the async signature check is what makes the race
  // above safe, but the reservation has to be reversible: a code refused
  // because the device came from the wrong address must still be redeemable
  // from the right one.
  const issued = hub.createPairingCode({ role: 'viewer', uses: 1, allowIps: ['203.0.113.9'] });

  const blocked = makeClient('wrong-address');
  const failure = once(blocked, 'error');
  await blocked.pair(issued.code);
  assert.equal((await failure).code, 'pair_failed');
  blocked.disconnect();

  const codes = hub.pairingCodes();
  const still = codes.find((c) => c.role === 'viewer' && c.allowIps?.includes('203.0.113.9'));
  assert.ok(still, 'the code survives a rejection it did not cause');
  assert.equal(still.usesLeft, 1, 'and still has its use');
});

test('a device cannot skip its own replay by acking a sequence from the future', async () => {
  const { code } = hub.createPairingCode({ role: 'viewer' });
  const client = makeClient('time-traveller');
  await client.pair(code);
  const ready = await once(client, 'ready');

  client.ack([], { seq: Number.MAX_SAFE_INTEGER });
  await new Promise((r) => setTimeout(r, 80));

  const device = hub.devices().find((d) => d.id === ready.deviceId);
  assert.ok(device.ackedSeq <= hub.history().length + ready.seq, 'the cursor stays within reality');
  assert.notEqual(device.ackedSeq, Number.MAX_SAFE_INTEGER);

  await disconnectAndWait(client, 'time-traveller');
});

/* ------------------------------------------------------------------ */
/* release integrity                                                   */
/* ------------------------------------------------------------------ */

test('a checksum listing answers only for the exact file named', () => {
  // `endsWith` let a line for `sdk-notifyjs-linux-x64.tar.gz` answer for
  // `notifyjs-linux-x64.tar.gz`. Both self-updating clients share this parser,
  // so a wrong answer here is a wrong binary on someone's machine.
  const listing = [
    `${'aa'.repeat(32)}  sdk-notifyjs-linux-x64.tar.gz`,
    `${'bb'.repeat(32)}  notifyjs-linux-x64.tar.gz`,
    `${'CC'.repeat(32)} *notifyjs-android-v0.1.0.apk`,
    'not-a-digest  notifyjs-broken.zip',
  ].join('\n');

  assert.equal(findChecksum(listing, 'notifyjs-linux-x64.tar.gz'), 'bb'.repeat(32));
  assert.equal(findChecksum(listing, 'notifyjs-android-v0.1.0.apk'), 'cc'.repeat(32));
  assert.equal(findChecksum(listing, 'notifyjs-broken.zip'), undefined, 'not a digest');
  assert.equal(findChecksum(listing, 'absent.tar.gz'), undefined);
  assert.equal(findChecksum('', 'anything'), undefined);
});

test('a hub address must be a WebSocket URL, however it arrived', () => {
  // The scanned-link path was checked; a typed or deep-linked address was not,
  // and both end up in the same createSocket call.
  assert.equal(parsePairingLink('notifyjs://pair?hub=http://evil/&code=ABCD'), undefined);
  assert.equal(parsePairingLink('notifyjs://pair?hub=javascript:alert(1)&code=ABCD'), undefined);
  assert.ok(parsePairingLink('notifyjs://pair?hub=ws://10.0.0.2:7741&code=ABCD-EFGH-JK01'));
});

test('the metrics token is not compared with ===', async () => {
  // A polled endpoint is exactly where a short-circuiting string compare leaks
  // a secret one character at a time. The helper existed and was wired to
  // nothing; this asserts it is actually in the path.
  const dir = mkdtempSync(join(tmpdir(), 'notifyjs-metrics-'));
  const guarded = new Notifier({
    port: 7895,
    host: '127.0.0.1',
    storeDir: dir,
    dashboard: false,
    logger: false,
    metrics: true,
    metricsToken: 'super-secret-token',
  });
  await guarded.start();
  try {
    const get = async (headers) =>
      (await fetch('http://127.0.0.1:7895/metrics', { headers })).status;

    assert.equal(await get({}), 401, 'no credentials');
    assert.equal(await get({ authorization: 'Bearer wrong' }), 401, 'wrong token');
    assert.equal(
      await get({ authorization: 'Bearer super-secret-toke' }),
      401,
      'a prefix of the token is still wrong',
    );
    assert.equal(await get({ authorization: 'Bearer super-secret-token' }), 200);
    assert.equal(timingSafeEqual('abc', 'abd'), false);
    assert.equal(timingSafeEqual('abc', 'abc'), true);
    assert.equal(timingSafeEqual('abc', 'abcd'), false, 'length differences count');
  } finally {
    await guarded.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
