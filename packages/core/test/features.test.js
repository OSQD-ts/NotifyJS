import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

import { Notifier, Store, FloodControl, renderQr } from '../dist/index.js';
import {
  NotifyClient,
  memoryStorage,
  inQuietHours,
  parsePairingLink,
  buildPairingLink,
} from '@osqd/notifyjs-protocol';
import { nodeCrypto } from '@osqd/notifyjs-protocol/node';

const PORT = 7861;
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

before(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'notifyjs-feat-'));
  hub = new Notifier({
    port: PORT,
    storeDir,
    dashboard: false,
    logger: false,
    replayLimit: 3,
    flood: { windowMs: 400, burst: 2 },
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
/* notify() reports what it reached                                    */
/* ------------------------------------------------------------------ */

test('notify() reports zero when no device is listening', async () => {
  const sent = await hub.error({ title: 'into the void', channel: 'db' });
  assert.equal(sent.reached, 0);
  assert.deepEqual(sent.deliveredTo, []);
  assert.equal(sent.coalesced, false);
});

test('notify() names the devices it reached', async () => {
  const a = makeClient('reach-a');
  const b = makeClient('reach-b');
  await a.pair(hub.createPairingCode({ role: 'oncall' }).code);
  await once(a, 'ready');
  await b.pair(hub.createPairingCode({ role: 'viewer' }).code);
  await once(b, 'ready');

  // A viewer's floor is 'info', so both roles qualify for an error.
  const sent = await hub.error({ title: 'reached both', channel: 'db' });
  assert.equal(sent.reached, 2);

  // oncall's floor is 'warning', so only the viewer sees an info.
  const info = await hub.info({ title: 'viewer only', channel: 'db' });
  assert.equal(info.reached, 1);

  a.disconnect();
  b.disconnect();
  await new Promise((r) => setTimeout(r, 150));
});

/* ------------------------------------------------------------------ */
/* Flood control                                                       */
/* ------------------------------------------------------------------ */

test('repeated identical alerts coalesce into one summary', async () => {
  const summaries = [];
  const onNotification = (n) => {
    if (n.tags?.includes('coalesced')) summaries.push(n);
  };
  hub.on('notification', onNotification);

  const results = [];
  for (let i = 0; i < 6; i++) {
    results.push(await hub.warn({ title: 'disk filling', channel: 'flood' }));
  }

  // burst is 2, so the first two go out and the remaining four are held.
  assert.deepEqual(
    results.map((r) => r.coalesced),
    [false, false, true, true, true, true],
  );

  await new Promise((r) => setTimeout(r, 600));
  assert.equal(summaries.length, 1, 'exactly one summary is emitted');
  assert.match(summaries[0].title, /disk filling \(x6 in \d+s\)/);
  assert.equal(summaries[0].data.occurrences, 6);
  assert.equal(summaries[0].data.suppressed, 4);
  hub.off('notification', onNotification);
});

test('critical alerts never wait for a summary window', async () => {
  const results = [];
  for (let i = 0; i < 5; i++) {
    results.push(await hub.critical({ title: 'on fire', channel: 'flood' }));
  }
  assert.ok(
    results.every((r) => r.coalesced === false),
    'every critical is delivered immediately',
  );
});

test('a distinct dedupe key groups alerts whose titles differ', () => {
  const summaries = [];
  const flood = new FloodControl(
    { enabled: true, windowMs: 50, burst: 1, alwaysDeliver: [] },
    (s) => summaries.push(s),
  );

  const make = (title) => ({ id: title, seq: 1, ts: Date.now(), channel: 'c', severity: 'error', title });

  // Titles differ, but the caller says these are one incident.
  assert.equal(flood.shouldCoalesce(make('host-1 down'), 'cluster-down'), false);
  assert.equal(flood.shouldCoalesce(make('host-2 down'), 'cluster-down'), true);
  assert.equal(flood.shouldCoalesce(make('host-3 down'), 'cluster-down'), true);

  flood.flushAll();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].total, 3);
  assert.equal(summaries[0].suppressed, 2);
});

/* ------------------------------------------------------------------ */
/* Replay cap                                                          */
/* ------------------------------------------------------------------ */

test('a long-offline device gets recent alerts plus a summary, not a flood', async () => {
  const storage = memoryStorage();
  const first = makeClient('returning', storage);
  await first.pair(hub.createPairingCode({ role: 'viewer' }).code);
  await once(first, 'ready');
  first.disconnect();
  await new Promise((r) => setTimeout(r, 150));

  // Ten while offline, against a replayLimit of 3. Distinct titles keep flood
  // control out of the way; this test is about replay.
  for (let i = 0; i < 10; i++) {
    await hub.error({ title: `missed ${i}`, channel: 'replay' });
  }

  const received = [];
  const second = makeClient('returning', storage);
  second.on('notification', (n) => received.push(n));
  await second.connect();
  await once(second, 'ready');
  await new Promise((r) => setTimeout(r, 300));

  const summary = received.find((n) => n.channel === 'notifyjs');
  assert.ok(summary, 'a summary of what was skipped is sent');
  assert.match(summary.title, /older notifications not shown/);
  assert.equal(summary.seq, 0, 'the synthetic entry must not move the ack cursor');

  const real = received.filter((n) => n.channel === 'replay');
  assert.equal(real.length, 3, 'capped at replayLimit');
  assert.deepEqual(
    real.map((n) => n.title),
    ['missed 7', 'missed 8', 'missed 9'],
    'the most recent are the ones kept',
  );
  second.disconnect();
});

/* ------------------------------------------------------------------ */
/* Origin policy                                                       */
/* ------------------------------------------------------------------ */

test('a cross-site browser origin is refused before the WebSocket exists', async () => {
  const outcome = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, {
      headers: { Origin: 'https://evil.example' },
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.on('open', () => resolve('open'));
    ws.on('error', () => resolve('error'));
  });
  assert.equal(outcome, 403);
});

test('the hub\'s own dashboard origin is accepted', async () => {
  const outcome = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, {
      headers: { Origin: `http://127.0.0.1:${PORT}` },
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.on('open', () => {
      ws.close();
      resolve('open');
    });
    ws.on('error', () => resolve('error'));
  });
  assert.equal(outcome, 'open');
});

test('a client sending no Origin is unaffected', async () => {
  const client = makeClient('headless');
  await client.pair(hub.createPairingCode({ role: 'viewer' }).code);
  const ready = await once(client, 'ready');
  assert.ok(ready.deviceId);
  client.disconnect();
});

/* ------------------------------------------------------------------ */
/* Clock skew                                                          */
/* ------------------------------------------------------------------ */

test('a client signs against the hub clock, not its own', async () => {
  // A hub whose clock is an hour ahead of this process. Without offset
  // correction the client would sign a timestamp an hour outside the hub's
  // 60-second window and be locked out permanently, with the error saying
  // only "authentication failed".
  const SKEW = 60 * 60_000;
  const captured = [];

  const server = new (await import('ws')).WebSocketServer({ port: 7864 });
  server.on('connection', (ws) => {
    ws.on('message', (raw) => captured.push(JSON.parse(raw.toString())));
    ws.send(
      JSON.stringify({
        v: 1,
        t: 'hello',
        serverId: 'fake-hub',
        serverName: 'Fake',
        nonce: 'test-nonce',
        serverTime: Date.now() + SKEW,
        handshakeTimeout: 10,
      }),
    );
  });

  const storage = memoryStorage();
  const keys = await nodeCrypto.generateKeyPair();
  await storage.set('notifyjs.deviceId', 'dev-1');
  await storage.set('notifyjs.publicKey', keys.publicKey);
  await storage.set('notifyjs.secretSeed', keys.secretSeed);

  const client = new NotifyClient({
    url: 'ws://127.0.0.1:7864',
    crypto: nodeCrypto,
    storage,
    createSocket: (url) => new WebSocket(url),
    deviceName: 'skewed',
    platform: 'node-test',
  });

  await client.connect();
  await new Promise((r) => setTimeout(r, 400));

  const auth = captured.find((m) => m.t === 'auth');
  assert.ok(auth, 'the client sent an auth frame');

  const drift = Math.abs(auth.ts - (Date.now() + SKEW));
  assert.ok(drift < 5000, `signed timestamp tracks the hub clock (drift ${drift}ms)`);
  assert.ok(
    Math.abs(client.clockSkewMs - SKEW) < 5000,
    'the client measured the offset it corrected for',
  );

  client.disconnect();
  await new Promise((r) => server.close(r));
});

/* ------------------------------------------------------------------ */
/* Pairing links and QR                                                */
/* ------------------------------------------------------------------ */

test('a pairing code carries a scannable link', () => {
  const issued = hub.createPairingCode({ role: 'oncall' });
  const parsed = parsePairingLink(issued.link);

  assert.ok(parsed, 'the link round-trips');
  assert.match(parsed.hub, /^wss?:\/\//);
  assert.equal(parsed.code, issued.code.replace(/-/g, ''));
  assert.match(issued.qr.svg, /^<svg /);
  assert.ok(issued.qr.terminal.split('\n').length > 10);
});

test('a pairing link pointing at a non-WebSocket URL is rejected', () => {
  assert.equal(parsePairingLink('notifyjs://pair?hub=http%3A%2F%2Fevil&code=ABCD'), undefined);
  assert.equal(parsePairingLink('https://example.com/pair?hub=ws%3A%2F%2Fx&code=A'), undefined);
  assert.equal(parsePairingLink('not a url at all'), undefined);
  assert.equal(parsePairingLink(buildPairingLink('ws://h:1/', 'AAAA-BBBB-CCCC')).code, 'AAAABBBBCCCC');
});

test('the QR encodes enough modules for a real pairing link', () => {
  const link = buildPairingLink('ws://192.168.100.200:7741', 'ABCD-EFGH-JKMN');
  const qr = renderQr(link);
  assert.match(qr.svg, /viewBox="0 0 \d+ \d+"/);
  assert.ok(qr.svg.includes('<path'), 'modules are drawn');
});

/* ------------------------------------------------------------------ */
/* Push wake-up                                                        */
/* ------------------------------------------------------------------ */

test('an offline device with a push token is woken; an online one is not', async () => {
  const pushes = [];
  const pushServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      pushes.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[]}');
    });
  });
  await new Promise((r) => pushServer.listen(7862, '127.0.0.1', r));

  const dir = mkdtempSync(join(tmpdir(), 'notifyjs-push-'));
  const pushHub = new Notifier({
    port: 7863,
    storeDir: dir,
    dashboard: false,
    logger: false,
    push: { enabled: true, endpoint: 'http://127.0.0.1:7862/send', includeBody: true },
    security: { connectionBurst: 500, connectionRefillPerSec: 100, maxConnectionsPerIp: 200 },
  });
  await pushHub.start();

  const client = new NotifyClient({
    url: 'ws://127.0.0.1:7863',
    crypto: nodeCrypto,
    storage: memoryStorage(),
    createSocket: (url) => new WebSocket(url),
    deviceName: 'pushy-phone',
    platform: 'node-test',
  });
  await client.pair(pushHub.createPairingCode({ role: 'oncall' }).code);
  await once(client, 'ready');

  client.registerPush('ExponentPushToken[test-token]');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(pushHub.devices()[0].pushToken, 'ExponentPushToken[test-token]');

  // Connected: the socket already delivered it, so no push is needed.
  await pushHub.error({ title: 'while online', channel: 'db' });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(pushes.length, 0, 'a connected device is not pushed to');

  client.disconnect();
  await new Promise((r) => setTimeout(r, 200));

  await pushHub.error({ title: 'while offline', channel: 'db' });
  await new Promise((r) => setTimeout(r, 400));

  assert.equal(pushes.length, 1, 'the offline device is woken');
  assert.equal(pushes[0][0].to, 'ExponentPushToken[test-token]');
  assert.match(pushes[0][0].title, /ERROR: while offline/);

  await pushHub.stop();
  await new Promise((r) => pushServer.close(r));
  rmSync(dir, { recursive: true, force: true });
});

test('push stays silent unless it is explicitly enabled', async () => {
  const client = makeClient('no-push');
  await client.pair(hub.createPairingCode({ role: 'oncall' }).code);
  await once(client, 'ready');
  client.registerPush('ExponentPushToken[ignored]');
  await new Promise((r) => setTimeout(r, 150));

  // The token is stored, but the default hub never contacts a push service.
  const device = hub.devices().find((d) => d.name === 'no-push');
  assert.equal(device.pushToken, 'ExponentPushToken[ignored]');
  client.disconnect();
});

/* ------------------------------------------------------------------ */
/* Store durability                                                    */
/* ------------------------------------------------------------------ */

test('a corrupt store is set aside rather than blocking startup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notifyjs-corrupt-'));
  writeFileSync(join(dir, 'store.json'), '{ this is not json');

  const store = new Store(dir, { history: 10, audit: 10 }, () => 'recovered');
  assert.equal(store.serverId, 'recovered', 'the hub still starts');
  assert.deepEqual(store.devices(), []);
  assert.ok(store.role('admin'), 'default roles are restored');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('history survives a restart and stays bounded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notifyjs-hist-'));
  const store = new Store(dir, { history: 4, audit: 4 }, () => 'srv');
  for (let i = 0; i < 20; i++) {
    store.pushHistory({ id: `n${i}`, seq: i, ts: Date.now(), channel: 'c', severity: 'info', title: `t${i}` });
  }
  store.close();

  const reopened = new Store(dir, { history: 4, audit: 4 }, () => 'unused');
  assert.equal(reopened.serverId, 'srv');
  assert.deepEqual(
    reopened.history().map((n) => n.title),
    ['t16', 't17', 't18', 't19'],
  );

  // The log is compacted rather than growing without bound.
  const lines = readFileSync(join(dir, 'history.jsonl'), 'utf8').trim().split('\n');
  assert.ok(lines.length <= 8, `expected a compacted log, got ${lines.length} lines`);
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Quiet hours boundaries                                              */
/* ------------------------------------------------------------------ */

test('quiet hours include their start and exclude their end', () => {
  const overnight = { start: 22, end: 7 };
  const at = (h, m = 0) => new Date(2026, 0, 1, h, m);

  assert.equal(inQuietHours(overnight, at(22)), true, 'starts exactly at 22:00');
  assert.equal(inQuietHours(overnight, at(21, 59)), false);
  assert.equal(inQuietHours(overnight, at(3)), true, 'wraps past midnight');
  assert.equal(inQuietHours(overnight, at(6, 59)), true);
  assert.equal(inQuietHours(overnight, at(7)), false, 'ends exactly at 07:00');

  const daytime = { start: 9, end: 17 };
  assert.equal(inQuietHours(daytime, at(9)), true);
  assert.equal(inQuietHours(daytime, at(16, 59)), true);
  assert.equal(inQuietHours(daytime, at(17)), false);
  assert.equal(inQuietHours(daytime, at(8, 59)), false);
});
