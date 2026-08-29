import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

import { Notifier, captureCrashes, expressErrorHandler, createLogStream, logHandler } from '../dist/index.js';
import { NotifyClient, memoryStorage } from '@notifyjs/protocol';
import { nodeCrypto } from '@notifyjs/protocol/node';

let hub;
let storeDir;

/** Collects what an adapter would have published. */
function sink() {
  const sent = [];
  return {
    sent,
    async notify(input) {
      sent.push(typeof input === 'string' ? { title: input } : input);
    },
    async call(input) {
      sent.push({ call: true, ...(typeof input === 'string' ? { message: input } : input) });
    },
  };
}

before(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'notifyjs-adp-'));
  hub = new Notifier({
    port: 7891,
    storeDir,
    dashboard: false,
    logger: false,
    security: {
      connectionBurst: 500,
      connectionRefillPerSec: 100,
      maxConnectionsPerIp: 200,
      // A tiny buffer so a non-reading client trips the guard quickly.
      maxBufferedBytes: 4096,
      messageRate: { points: 100000, windowMs: 10_000 },
    },
  });
  await hub.start();
});

after(async () => {
  await hub?.stop();
  if (storeDir) rmSync(storeDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Backpressure                                                        */
/* ------------------------------------------------------------------ */

test('a session stops writing once its peer stops draining', async () => {
  const { Session } = await import('../dist/session.js');

  // A fake socket whose buffer only grows, standing in for a peer that has
  // stopped reading. Deterministic, unlike relying on kernel buffers to fill.
  let terminated = false;
  let sent = 0;
  const fake = {
    readyState: 1,
    bufferedAmount: 0,
    send(data) {
      sent += 1;
      this.bufferedAmount += data.length;
    },
    close() {},
    terminate() {
      terminated = true;
    },
  };

  const session = new Session('s1', fake, '127.0.0.1', undefined, { points: 1e6, windowMs: 1000 }, 5000);

  for (let i = 0; i < 50; i++) {
    session.send({ v: 1, t: 'notification', n: { id: `n${i}`, title: 'x'.repeat(500) } });
  }

  assert.ok(terminated, 'the peer was dropped');
  assert.equal(session.stalled, true);
  assert.ok(sent < 50, `writing stopped early (${sent} of 50 frames)`);

  // Once stalled, nothing more is written even if called again.
  const before = sent;
  session.send({ v: 1, t: 'ping' });
  assert.equal(sent, before, 'a stalled session accepts no further writes');
});

test('a real device that never reads is disconnected by the hub', async () => {
  let socket;
  const client = new NotifyClient({
    url: 'ws://127.0.0.1:7891',
    crypto: nodeCrypto,
    storage: memoryStorage(),
    createSocket: (url) => {
      socket = new WebSocket(url);
      return socket;
    },
    deviceName: 'deaf-device',
    platform: 'node-test',
  });

  await client.pair(hub.createPairingCode({ role: 'viewer' }).code);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('never became ready')), 5000);
    client.on('ready', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  // Stop draining TCP while staying connected. Kernel buffers absorb a few
  // hundred KB, so this has to push well past that to reach the guard.
  socket._socket.pause();

  const before = hub.auditLog(1000).filter((e) => e.kind === 'session.stalled').length;
  const body = 'x'.repeat(3900);
  for (let i = 0; i < 1500; i++) {
    await hub.info({ title: `flood ${i}`, body, channel: 'bp' });
  }
  await new Promise((r) => setTimeout(r, 800));

  const after = hub.auditLog(1000).filter((e) => e.kind === 'session.stalled').length;
  assert.ok(after > before, 'the stalled peer was disconnected rather than buffered');

  socket.terminate();
});

/* ------------------------------------------------------------------ */
/* Crash capture                                                       */
/* ------------------------------------------------------------------ */

test('an unhandled rejection is reported', async () => {
  const s = sink();
  const before = process.listeners('unhandledRejection').length;
  const stop = captureCrashes(s, { exit: false, drainMs: 50 });
  const handlers = process.listeners('unhandledRejection');
  assert.equal(handlers.length, before + 1, 'the handler was registered');

  await handlers[handlers.length - 1](new Error('promise went bad'), Promise.resolve());
  await new Promise((r) => setTimeout(r, 100));

  stop();
  const alert = s.sent.find((a) => a.title?.includes('promise went bad'));
  assert.ok(alert, 'the rejection was published');
  assert.equal(alert.severity, 'critical');
  assert.equal(alert.channel, 'crash');
  assert.ok(alert.dedupeKey, 'a crash loop collapses instead of paging repeatedly');
});

test('removing the handler deregisters it', async () => {
  const s = sink();
  const before = process.listeners('unhandledRejection').length;
  const stop = captureCrashes(s, { exit: false, drainMs: 10 });
  assert.equal(process.listeners('unhandledRejection').length, before + 1);

  stop();
  assert.equal(
    process.listeners('unhandledRejection').length,
    before,
    'the process is left as it was found',
  );
  assert.equal(s.sent.length, 0);
});

/* ------------------------------------------------------------------ */
/* HTTP middleware                                                     */
/* ------------------------------------------------------------------ */

test('express middleware reports 5xx and passes the error on', async () => {
  const s = sink();
  const middleware = expressErrorHandler(s);

  let forwarded;
  const err = Object.assign(new Error('database exploded'), { status: 500 });
  middleware(err, { method: 'POST', originalUrl: '/checkout' }, {}, (e) => (forwarded = e));
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(forwarded, err, 'the error still reaches the app handler');
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].title, /500 on POST \/checkout/);
  assert.equal(s.sent[0].data.status, 500);
});

test('express middleware ignores client errors', async () => {
  const s = sink();
  const middleware = expressErrorHandler(s);

  middleware(
    Object.assign(new Error('not found'), { status: 404 }),
    { method: 'GET', originalUrl: '/missing' },
    {},
    () => {},
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.sent.length, 0, '404s are noise, not incidents');
});

/* ------------------------------------------------------------------ */
/* Log forwarding                                                      */
/* ------------------------------------------------------------------ */

test('a pino stream forwards errors and drops chatter', async () => {
  const s = sink();
  const stream = createLogStream(s);

  stream.write(JSON.stringify({ level: 30, msg: 'listening on 3000' }) + '\n');
  stream.write(JSON.stringify({ level: 50, msg: 'payment failed' }) + '\n');
  stream.write(JSON.stringify({ level: 60, msg: 'out of memory' }) + '\n');
  await new Promise((r) => setTimeout(r, 60));

  assert.deepEqual(
    s.sent.map((a) => [a.severity, a.title]),
    [
      ['error', 'payment failed'],
      ['critical', 'out of memory'],
    ],
    'info is dropped; error and fatal are forwarded',
  );
});

test('a malformed log line never breaks the logger', async () => {
  const s = sink();
  const stream = createLogStream(s);
  stream.write('this is not json\n');
  stream.write(JSON.stringify({ level: 50, msg: 'still working' }) + '\n');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].title, 'still working');
});

test('the record handler maps winston-style levels', async () => {
  const s = sink();
  const handle = logHandler(s, { minSeverity: 'warning' });

  handle({ level: 'info', message: 'ignored' });
  handle({ level: 'warn', message: 'disk getting full' });
  handle({ level: 'error', message: 'query failed', stack: 'at db.js:1' });
  await new Promise((r) => setTimeout(r, 60));

  assert.deepEqual(
    s.sent.map((a) => [a.severity, a.title]),
    [
      ['warning', 'disk getting full'],
      ['error', 'query failed'],
    ],
  );
  assert.equal(s.sent[1].body, 'at db.js:1');
});

test('adapters work against a real hub', async () => {
  const middleware = expressErrorHandler(hub, { channel: 'web' });
  middleware(
    Object.assign(new Error('live error'), { status: 503 }),
    { method: 'GET', originalUrl: '/health' },
    {},
    () => {},
  );
  await new Promise((r) => setTimeout(r, 100));

  assert.ok(
    hub.history().some((n) => n.title.includes('503 on GET /health') && n.channel === 'web'),
    'the hub recorded what the middleware published',
  );
});
