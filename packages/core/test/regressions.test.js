/**
 * Regressions for defects that were live in the shipped code.
 *
 * Each test here failed before its fix, and each covers something a user would
 * have noticed: a dashboard that would not load, a watchdog that cried wolf,
 * a push fan-out that silently stopped past a hundred devices.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

import { Notifier, Store, CallOrchestrator, createLogStream } from '../dist/index.js';
import { NotifyClient, memoryStorage, toBase64Url } from '@osqd/notifyjs-protocol';
import { nodeCrypto } from '@osqd/notifyjs-protocol/node';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `notifyjs-${prefix}-`));
}

/** A device speaking the same client the phone and dashboard use. */
function makeClient(hub, name, opts = {}) {
  return new NotifyClient({
    url: hub.url.replace('localhost', '127.0.0.1'),
    crypto: nodeCrypto,
    storage: memoryStorage(),
    createSocket: (url) => new WebSocket(url),
    deviceName: name,
    platform: 'node-test',
    autoReconnect: false,
    ...opts,
  });
}

/* ------------------------------------------------------------------ */
/* The dashboard                                                       */
/* ------------------------------------------------------------------ */

test('the built dashboard has no import a browser cannot resolve', () => {
  // The rewrite in packages/web/build.mjs was keyed on the package's old name.
  // It matched nothing, the build reported success, and every dashboard
  // shipped with a bare specifier that throws before the page renders.
  const app = readFileSync(join(REPO, 'packages/web/dist/app.js'), 'utf8');
  // Anchored to the start of a line: tsc emits module imports at the top level,
  // and a looser pattern also matches `from` inside ordinary string literals.
  const bare = [...app.matchAll(/^(?:import|export)\b[^'"]*?from\s*(['"])(?![./])([^'"]+)\1/gm)]
    .map((m) => m[2]);
  assert.deepEqual(bare, [], 'dashboard must import only relative paths');
  assert.match(app, /from '\.\/vendor\/protocol\/index\.js'/);
});

/* ------------------------------------------------------------------ */
/* The hub                                                             */
/* ------------------------------------------------------------------ */

test('a hub asked for port 0 reports the port it actually got', async () => {
  // Without reading the bound port back, `url`, `publicUrl` and every pairing
  // link said ":0" - a hub that is reachable but cannot say where.
  const dir = tmp('port0');
  const hub = new Notifier({ port: 0, storeDir: dir, dashboard: false, logger: false });

  const listening = new Promise((r) => hub.on('listening', r));
  await hub.start();
  const event = await listening;

  assert.ok(event.port > 0, 'the listening event carries a real port');
  assert.equal(new URL(hub.url).port, String(event.port));
  assert.ok(!hub.createPairingCode({ role: 'viewer' }).link.includes(':0'));

  await hub.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('renaming a device strips control characters, as pairing does', async () => {
  // `devices.rename` is reachable over the wire and the result reaches an
  // operator's terminal and log lines; it was the one path that skipped the
  // sanitising `pair` has always done.
  const dir = tmp('rename');
  const hub = new Notifier({ port: 0, storeDir: dir, dashboard: false, logger: false });
  await hub.start();

  const client = makeClient(hub, 'victim');
  const paired = new Promise((resolve) => client.on('paired', resolve));
  await client.pair(hub.createPairingCode({ role: 'viewer' }).code);
  const { deviceId } = await paired;

  const renamed = hub.renameDevice(deviceId, 'we\u001b[31mred\u0007 name');
  assert.equal(renamed.name, 'we[31mred name', 'escapes and control bytes are dropped');
  assert.ok(!renamed.name.includes('\u001b'));
  assert.ok(!renamed.name.includes('\u0007'));

  // A name that is nothing but control characters is refused outright rather
  // than stored as an empty string.
  assert.equal(hub.renameDevice(deviceId, '\u0007\u0007'), undefined);
  assert.equal(hub.devices()[0].name, 'we[31mred name', 'the old name stands');

  client.disconnect();
  await hub.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('a store whose collections are corrupt still boots', () => {
  // Only `roles` was guarded. A document truncated or hand-edited into
  // `"devices": null` took the hub down on its first device lookup.
  const dir = tmp('corrupt');
  writeFileSync(
    join(dir, 'store.json'),
    JSON.stringify({
      version: 1,
      serverId: 'kept',
      seq: 'not-a-number',
      devices: null,
      roles: 'nonsense',
      codes: [],
      bans: undefined,
      heartbeats: 7,
      policies: null,
    }),
  );

  const store = new Store(dir, { history: 10, audit: 10 }, () => 'fresh');
  assert.equal(store.serverId, 'kept', 'a usable serverId survives');
  assert.deepEqual(store.devices(), []);
  assert.deepEqual(store.codes(), []);
  assert.deepEqual(store.bans(), []);
  assert.deepEqual(store.heartbeats(), []);
  assert.deepEqual(store.policies(), []);
  // The shipped roles are restored rather than lost.
  assert.ok(store.role('admin'), 'default roles are merged back in');
  // A non-numeric seq would have made every notification`s seq NaN.
  assert.equal(store.nextSeq(), 1);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Calls                                                               */
/* ------------------------------------------------------------------ */

test('an answered call that never reports back is eventually released', async () => {
  // The record was kept so a later `call.ended` could still emit. A device
  // that is force-quit never sends one, and the call stayed "active" for the
  // life of the process - counted by /metrics as still ringing.
  const calls = new CallOrchestrator(30, () => {});
  const target = { deviceId: 'd1', deviceName: 'phone', send: () => {} };
  const request = { id: 'c1', seq: 1, ts: Date.now(), channel: 'x', severity: 'critical', from: 'test', message: 'hi' };

  const settled = calls.place(request, [{ targets: [target], ringSeconds: 30, delaySeconds: 0 }], 0);
  calls.answer('c1', 'd1');
  assert.equal((await settled).outcome, 'answered');
  assert.equal(calls.activeCount, 1, 'kept for a call.ended that may still come');

  // Shutting down releases it; so does the reaper, on a far longer fuse.
  calls.cancelAll();
  assert.equal(calls.activeCount, 0, 'no call record outlives the orchestrator');
});

/* ------------------------------------------------------------------ */
/* Adapters                                                            */
/* ------------------------------------------------------------------ */

test('a log stream survives a malformed line and a split one', async () => {
  const seen = [];
  const sink = { notify: async (n) => void seen.push(n.title) };
  const stream = createLogStream(sink, { minSeverity: 'error' });

  // One unparseable line used to abort the whole chunk, taking every later
  // line in it with it.
  stream.write('not json at all\n' + JSON.stringify({ level: 50, msg: 'after the garbage' }) + '\n');

  // A logger writing to a stream can split a record across two chunks. Parsing
  // each chunk alone dropped both halves, and with them the alert.
  const record = JSON.stringify({ level: 60, msg: 'split across chunks' });
  stream.write(record.slice(0, 12));
  stream.write(record.slice(12) + '\n');

  // A final line with no trailing newline still counts.
  stream.write(JSON.stringify({ level: 50, msg: 'no trailing newline' }));
  await new Promise((resolve) => stream.end(resolve));
  await new Promise((r) => setImmediate(r));
  assert.ok(seen.includes('after the garbage'), 'a bad line only costs that line');
  assert.ok(seen.includes('split across chunks'), 'a record split across writes still arrives');
  assert.ok(seen.includes('no trailing newline'), 'the last line is flushed on end');
});

test('a log level that names an Object.prototype member is not a severity', async () => {
  const seen = [];
  const sink = { notify: async (n) => void seen.push(n.title) };
  const stream = createLogStream(sink, { minSeverity: 'debug' });
  stream.write(JSON.stringify({ level: 'constructor', msg: 'inherited' }) + '\n');
  await new Promise((resolve) => stream.end(resolve));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, [], 'a prototype member never reads as a level');
});

/* ------------------------------------------------------------------ */
/* Push                                                                */
/* ------------------------------------------------------------------ */

test('push fans out in batches of 100 and retires unreachable tokens', async () => {
  // Expo refuses a request carrying more than 100 messages, so a single
  // oversized batch delivered nothing at all rather than merely less.
  const batches = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const messages = JSON.parse(body);
      batches.push(messages.length);
      // Answer the first message of the first batch as a dead token.
      const data = messages.map((_, i) =>
        batches.length === 1 && i === 0
          ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }
          : { status: 'ok' },
      );
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${server.address().port}/send`;

  const dir = tmp('pushbatch');
  const hub = new Notifier({
    port: 0,
    storeDir: dir,
    dashboard: false,
    logger: false,
    push: { enabled: true, endpoint, evenWhenOnline: true },
  });
  await hub.start();

  const { PushSender } = await import('../dist/push.js');
  const retired = [];
  const sender = new PushSender(
    { enabled: true, endpoint, includeBody: false, evenWhenOnline: true },
    () => {},
    () => {},
    (id) => retired.push(id),
  );

  const devices = Array.from({ length: 250 }, (_, i) => ({
    id: `d${i}`,
    name: `phone-${i}`,
    role: 'viewer',
    publicKey: 'k'.repeat(43),
    platform: 'test',
    status: 'active',
    createdAt: Date.now(),
    ackedSeq: 0,
    pushToken: `ExponentPushToken[${i}]`,
  }));

  await sender.notify(devices, {
    id: 'n1', seq: 1, ts: Date.now(), channel: 'x', severity: 'error', title: 'batched',
  });

  assert.equal(batches.length, 3, '250 devices become three requests');
  assert.deepEqual(batches.sort((a, b) => b - a), [100, 100, 50]);
  assert.deepEqual(retired, ['d0'], 'a DeviceNotRegistered ticket retires that token');

  await hub.stop();
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

test('a deliberate disconnect does not raise the service watchdog', async () => {
  // `disconnect()` disarms the watchdog on purpose, and `onclose` re-armed it
  // a tick later - so muting a source, or any planned shutdown, reported the
  // hub as down a moment afterwards.
  const dir = tmp('watchdog');
  const hub = new Notifier({
    port: 0,
    storeDir: dir,
    dashboard: false,
    logger: false,
    deviceWatchdog: { enabled: true, intervalMs: 40, graceMs: 10 },
  });
  await hub.start();

  const client = makeClient(hub, 'watcher');

  const ready = new Promise((resolve) => client.on('ready', resolve));
  await client.pair(hub.createPairingCode({ role: 'viewer' }).code);
  await ready;

  let missing = 0;
  client.on('service:missing', () => (missing += 1));

  client.disconnect();
  // Comfortably past intervalMs + graceMs.
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(missing, 0, 'leaving on purpose is not the service dying');

  await hub.stop();
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Encoding                                                            */
/* ------------------------------------------------------------------ */

test('base64url encoding is unchanged by the Buffer fast path', () => {
  for (const n of [0, 1, 2, 3, 7, 32, 64, 255]) {
    const bytes = new Uint8Array(Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff));
    const expected = Buffer.from(bytes)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    assert.equal(toBase64Url(bytes), expected, `length ${n}`);
  }
});


/* ------------------------------------------------------------------ */
/* Wire-reachable input                                                */
/* ------------------------------------------------------------------ */

/** Escape and bell, built at runtime to keep raw bytes out of this source. */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

test('an escalation policy from the wire is bounded before it reaches a timer', async () => {
  // `policies.upsert` needs only `roles.manage`, and every number in the
  // result is handed to setTimeout or used as a loop bound.
  const dir = tmp('policy');
  const hub = new Notifier({ port: 0, storeDir: dir, dashboard: false, logger: false });
  await hub.start();

  hub.upsertPolicy({
    name: 'hostile',
    description: 'x'.repeat(500),
    repeat: Number.POSITIVE_INFINITY,
    steps: [
      { ringSeconds: 1e12, delaySeconds: 1e12 },
      { ringSeconds: 'soon', delaySeconds: -5 },
      ...Array.from({ length: 500 }, () => ({ ringSeconds: 5 })),
    ],
  });

  const [policy] = hub.policies();
  assert.ok(policy.steps.length <= 50, 'the ladder is capped');
  assert.ok(policy.repeat >= 0 && policy.repeat <= 10, 'repeat is finite and bounded');
  assert.equal(policy.description.length, 200);
  assert.ok(policy.steps[0].ringSeconds <= 600, 'a rung cannot ring for a century');
  assert.ok(policy.steps[0].delaySeconds <= 3600, 'a rung cannot be delayed for a century');
  // An unparseable duration falls through to the call's own default.
  assert.equal(policy.steps[1].ringSeconds, undefined);
  assert.equal(policy.steps[1].delaySeconds, 0, 'a negative delay clamps to none');

  assert.throws(() => hub.upsertPolicy({ name: '', steps: [{}] }), /needs a name/);
  assert.throws(() => hub.upsertPolicy({ name: 'x' }), /at least one step/);

  await hub.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('a heartbeat the store will not hold is not left in the watchdog', async () => {
  // The name was validated by the store only, and only after the watchdog had
  // already registered the beat - leaving one that alerted forever and never
  // survived a restart.
  const dir = tmp('beat');
  const hub = new Notifier({ port: 0, storeDir: dir, dashboard: false, logger: false });
  await hub.start();

  assert.throws(() => hub.expect('__proto__', { every: '1h' }), /cannot be used/);
  assert.throws(() => hub.expect('', { every: '1h' }), /needs a name/);
  assert.deepEqual(hub.heartbeats(), [], 'nothing was registered');

  // A name carrying an escape sequence is cleaned rather than rejected.
  const beat = hub.expect(`nightly${ESC}[31m${BEL} backup`, { every: '1h' });
  assert.ok(!beat.name.includes(ESC), 'the escape byte is stripped');
  assert.ok(!beat.name.includes(BEL), 'the bell byte is stripped');
  assert.equal(beat.name, 'nightly[31m backup');
  assert.equal(hub.heartbeats().length, 1);

  await hub.stop();
  rmSync(dir, { recursive: true, force: true });
});


test('an admin op naming an Object.prototype member is refused', async () => {
  // `msg.op` indexes the capability table directly. A plain object answers
  // `constructor` with a truthy function, and the deny then rested on the
  // capability check that follows rather than on the lookup itself.
  const dir = tmp('adminproto');
  const hub = new Notifier({ port: 0, storeDir: dir, dashboard: false, logger: false });
  await hub.start();

  const client = makeClient(hub, 'admin-box');
  const ready = new Promise((resolve) => client.on('ready', resolve));
  await client.pair(hub.createPairingCode({ role: 'admin' }).code);
  await ready;

  // An admin device holds every capability, so a leaked prototype member would
  // pass the check that currently saves this by accident.
  for (const op of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    await assert.rejects(() => client.admin(op), /forbidden|unknown op/, `op "${op}" is refused`);
  }

  // A real op on the same connection still works, so the test is not passing
  // because the device was simply unable to do anything.
  const listed = await client.admin('devices.list');
  assert.equal(listed.devices.length, 1);

  client.disconnect();
  await hub.stop();
  rmSync(dir, { recursive: true, force: true });
});


test('a token registered through a source reaches the hub and is used', async () => {
  // The phone app never called this. The hub could send wake-ups, the protocol
  // carried `push.register`, and the app had a `getPushToken()` helper - but
  // nothing joined them, so no device ever had a token and every wake-up was
  // filtered out before it was sent.
  const { SourceManager } = await import('@osqd/notifyjs-protocol');

  const pushed = [];
  const pushServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      pushed.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ status: 'ok' }] }));
    });
  });
  await new Promise((r) => pushServer.listen(0, '127.0.0.1', r));

  const dir = tmp('pushwire');
  const hub = new Notifier({
    port: 0,
    storeDir: dir,
    dashboard: false,
    logger: false,
    push: {
      enabled: true,
      endpoint: `http://127.0.0.1:${pushServer.address().port}/send`,
      evenWhenOnline: true,
    },
    security: { connectionBurst: 500, connectionRefillPerSec: 100, maxConnectionsPerIp: 200 },
  });
  await hub.start();

  const manager = new SourceManager({
    storage: memoryStorage(),
    crypto: nodeCrypto,
    createSocket: (url) => new WebSocket(url),
    platform: 'node-test',
    deviceName: () => 'phone',
    minSeverity: () => 'debug',
  });

  const source = await manager.add({
    url: hub.url.replace('localhost', '127.0.0.1'),
    code: hub.createPairingCode({ role: 'oncall' }).code,
  });
  assert.equal(source.status, 'ready');

  // What the app now does once a source reports ready.
  manager.registerPush(source.id, 'ExponentPushToken[wired]');
  await new Promise((r) => setTimeout(r, 150));

  const [device] = hub.devices();
  assert.equal(device.pushToken, 'ExponentPushToken[wired]', 'the hub stored the token');
  assert.equal(device.pushProvider, 'expo');

  await hub.error({ title: 'wake the phone', channel: 'db' });
  await new Promise((r) => setTimeout(r, 250));

  assert.equal(pushed.length, 1, 'the hub actually sent a wake-up');
  assert.equal(pushed[0][0].to, 'ExponentPushToken[wired]');

  manager.disconnectAll();
  await hub.stop();
  await new Promise((r) => pushServer.close(r));
  rmSync(dir, { recursive: true, force: true });
});


/* ------------------------------------------------------------------ */
/* Build wiring                                                        */
/* ------------------------------------------------------------------ */

test('every workspace package declares a project reference for what it imports', () => {
  // `packages/web` imported the protocol and declared no reference to it, so
  // `tsc -b` never marked the dashboard out of date when protocol types
  // changed: breakage in the one package with no other typecheck compiled
  // clean and the monorepo build reported success.
  const { name: WORKSPACE } = JSON.parse(
    readFileSync(join(REPO, 'packages/protocol/package.json'), 'utf8'),
  );
  const scope = WORKSPACE.split('/')[0]; // "@osqd"

  const byPackageName = new Map();
  for (const dir of ['protocol', 'core', 'web', 'cli']) {
    const manifest = JSON.parse(readFileSync(join(REPO, 'packages', dir, 'package.json'), 'utf8'));
    byPackageName.set(manifest.name, dir);
  }

  const missing = [];
  for (const [, dir] of byPackageName) {
    const base = join(REPO, 'packages', dir);
    const tsconfig = JSON.parse(stripComments(readFileSync(join(base, 'tsconfig.json'), 'utf8')));
    const declared = new Set(
      (tsconfig.references ?? []).map((r) => r.path.replace(/^\.\.\//, '')),
    );

    // Only real module imports. A package name inside `require.resolve()` is a
    // runtime path lookup - core locates the dashboard's assets that way - and
    // needs no project reference, because no type crosses the boundary.
    const importFrom = new RegExp(
      `(?:^|\\s)(?:import|export)\\b[^'"]*?from\\s*['"](${escapeRe(scope)}/[\\w-]+)`,
      'gm',
    );
    const imported = new Set();
    for (const file of walk(join(base, 'src'))) {
      const code = readFileSync(file, 'utf8');
      for (const m of code.matchAll(importFrom)) {
        // A subpath import (`.../protocol/node`) still points at that package.
        const target = byPackageName.get(m[1]) ?? byPackageName.get(m[1].replace(/\/[^/]+$/, ''));
        if (target && target !== dir) imported.add(target);
      }
    }

    for (const target of imported) {
      if (!declared.has(target)) missing.push(`${dir} imports ${target} without a reference`);
    }
  }

  assert.deepEqual(missing, [], 'a tsc -b build cannot see an undeclared dependency');
});

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

/** Enough of a JSONC reader for tsconfig's line comments. */
function stripComments(text) {
  return text.replace(/^\s*\/\/.*$/gm, '');
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}


/* ------------------------------------------------------------------ */
/* Release tooling                                                     */
/* ------------------------------------------------------------------ */

test('set-version stamps one version across the packages and their links', async () => {
  // This runs immediately before `npm publish`. Its whole job is to stop the
  // published packages depending on a version of each other that does not
  // exist - and it had no coverage at all.
  const { setVersion, PACKAGES } = await import(
    pathToFileURL(join(REPO, 'scripts/set-version.mjs')).href
  );

  assert.ok(PACKAGES.length > 1, 'there is more than one publishable package');

  // Real manifests, copied somewhere disposable.
  const dir = tmp('setversion');
  for (const pkg of PACKAGES) {
    mkdirSync(join(dir, 'packages', pkg), { recursive: true });
    writeFileSync(
      join(dir, 'packages', pkg, 'package.json'),
      readFileSync(join(REPO, 'packages', pkg, 'package.json'), 'utf8'),
    );
  }

  const cwd = process.cwd();
  try {
    // `setVersion` resolves manifests relative to the script, so run the copy.
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(
      join(dir, 'scripts', 'set-version.mjs'),
      readFileSync(join(REPO, 'scripts/set-version.mjs'), 'utf8'),
    );
    const copied = await import(pathToFileURL(join(dir, 'scripts/set-version.mjs')).href);
    copied.setVersion('9.9.9-test');

    const names = new Set();
    for (const pkg of PACKAGES) {
      const json = JSON.parse(readFileSync(join(dir, 'packages', pkg, 'package.json'), 'utf8'));
      names.add(json.name);
    }

    for (const pkg of PACKAGES) {
      const json = JSON.parse(readFileSync(join(dir, 'packages', pkg, 'package.json'), 'utf8'));
      assert.equal(json.version, '9.9.9-test', `${pkg} version`);
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
        for (const [name, range] of Object.entries(json[field] ?? {})) {
          if (!names.has(name)) continue;
          // A workspace sibling must be pinned to exactly what is being
          // published alongside it, never a range or a stale literal.
          assert.equal(range, '9.9.9-test', `${pkg} -> ${name} must be pinned`);
        }
      }
    }
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a run: block never carries an expression GitHub will choke on', () => {
  // This shipped. A comment inside a `run:` block explaining why you must not
  // interpolate an expression into a shell contained the empty expression as
  // its example - and GitHub scans the whole block for expressions without
  // caring that a `#` starts a shell comment. The workflow was rejected at
  // load time with "An expression was expected", pointing at the block scalar
  // rather than at the line, on a push that had already happened.
  const check = join(REPO, 'scripts/check-workflow-hardening.mjs');

  const dir = tmp('hardening');
  try {
    const fixture = join(dir, 'broken.yml');
    writeFileSync(
      fixture,
      [
        'name: Broken',
        'on: push',
        'permissions:',
        '  contents: read',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: |',
        // The exact shape that broke it.
        '          # an expression like ${{ }} would paste it into the shell',
        '          echo hi',
        '',
      ].join('\n'),
    );

    const broken = spawnSync(process.execPath, [check, fixture], { encoding: 'utf8' });
    assert.equal(broken.status, 1, 'an empty expression in a run: block must fail');
    assert.match(broken.stderr, /empty expression/);

    // And the workflows this repository actually ships must stay loadable.
    // Running the checker over them here is what turns "GitHub rejected the
    // file" into a test failure before the push rather than after it.
    const real = spawnSync(
      process.execPath,
      [check, ...readdirSync(join(REPO, '.github/workflows'))
        .filter((f) => f.endsWith('.yml'))
        .map((f) => join(REPO, '.github/workflows', f))],
      { encoding: 'utf8' },
    );
    assert.equal(real.status, 0, `the repository's own workflows: ${real.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('set-version reaches the manifests nothing publishes', async () => {
  // The desktop app's version is what it reports to a hub, and the mobile
  // app's is the versionName inside the APK. Neither was ever stamped, so
  // every release shipped apps claiming to be 0.1.0 - and an Android
  // versionCode that never moved is an APK a phone refuses to upgrade to.
  const mod = await import(
    pathToFileURL(join(REPO, 'scripts/set-version.mjs')).href
  );

  const dir = tmp('setversion-private');
  try {
    // A checkout shaped like the real one, down to the `file:` links the two
    // private apps use to resolve the protocol package.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', version: '0.1.0' }));
    for (const pkg of mod.PACKAGES) {
      mkdirSync(join(dir, 'packages', pkg), { recursive: true });
      writeFileSync(
        join(dir, 'packages', pkg, 'package.json'),
        readFileSync(join(REPO, 'packages', pkg, 'package.json'), 'utf8'),
      );
    }
    for (const app of ['desktop', 'mobile']) {
      mkdirSync(join(dir, 'packages', app), { recursive: true });
      writeFileSync(
        join(dir, 'packages', app, 'package.json'),
        readFileSync(join(REPO, 'packages', app, 'package.json'), 'utf8'),
      );
    }
    writeFileSync(
      join(dir, 'packages', 'mobile', 'app.json'),
      readFileSync(join(REPO, 'packages/mobile/app.json'), 'utf8'),
    );

    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(
      join(dir, 'scripts', 'set-version.mjs'),
      readFileSync(join(REPO, 'scripts/set-version.mjs'), 'utf8'),
    );
    const copied = await import(pathToFileURL(join(dir, 'scripts/set-version.mjs')).href);
    copied.setVersion('2.3.4');

    const read = (...parts) => JSON.parse(readFileSync(join(dir, ...parts), 'utf8'));

    assert.equal(read('package.json').version, '2.3.4', 'the root manifest');
    assert.equal(read('packages', 'desktop', 'package.json').version, '2.3.4', 'the desktop app');
    assert.equal(read('packages', 'mobile', 'package.json').version, '2.3.4', 'the mobile app');

    const expo = read('packages', 'mobile', 'app.json').expo;
    assert.equal(expo.version, '2.3.4', 'the Expo versionName');
    assert.equal(expo.android.versionCode, 2003004, 'the Android versionCode');

    // The whole reason the two apps can be built from a checkout at all. A
    // release rewrote this to a version number once, pointing the build at a
    // tarball the registry did not have yet.
    for (const app of ['desktop', 'mobile']) {
      const deps = read('packages', app, 'package.json').dependencies ?? {};
      assert.equal(
        deps['@osqd/notifyjs-protocol'],
        'file:../protocol',
        `${app} must keep its file: link`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('versionCode only ever increases, in the order semver does', async () => {
  const { versionCode } = await import(
    pathToFileURL(join(REPO, 'scripts/set-version.mjs')).href
  );

  const ordered = ['0.1.0', '0.1.1', '0.2.0', '0.9.9', '1.0.0', '1.0.1', '2.0.0'];
  const codes = ordered.map(versionCode);
  for (let i = 1; i < codes.length; i += 1) {
    assert.ok(
      codes[i] > codes[i - 1],
      `${ordered[i]} (${codes[i]}) must outrank ${ordered[i - 1]} (${codes[i - 1]})`,
    );
  }
  // Android's own ceiling. Passing it makes the APK unbuildable, not merely wrong.
  assert.ok(codes.at(-1) < 2_100_000_000);
  // A prerelease is still the version it is a prerelease of.
  assert.equal(versionCode('1.2.3-main.7'), versionCode('1.2.3'));
});

test('next-version reads a bump out of a commit subject', async () => {
  const { classify } = await import(
    pathToFileURL(join(REPO, 'scripts/next-version.mjs')).href
  );

  const cases = [
    ['Feat: snooze windows', '', 'minor'],
    ['feat(mobile): lowercase and scoped', '', 'minor'],
    ['Fix: retry backoff', '', 'patch'],
    // Not conventional-commits' default, and deliberate: in this repository
    // `Refactor:` has meant "Security improvements".
    ['Refactor: rework the store', '', 'patch'],
    ['CI: pin the runner', '', 'none'],
    ['Docs: fix a typo', '', 'none'],
    // Unrecognised subjects release nothing rather than defaulting to a patch.
    // `Init` and `License Rename` are both real commits in this history.
    ['License Rename', '', 'none'],
    ['Init', '', 'none'],
    ['Feat!: drop the v1 handshake', '', 'major'],
    ['Fix: something', 'BREAKING CHANGE: store.json moved', 'major'],
    // How a squash merge actually writes it: every branch commit becomes a
    // bullet, so the footer is no longer at the start of its line. Missing
    // this ships a breaking change as a patch.
    ['Fix: something', '* Fix: a\n* BREAKING CHANGE: store.json moved', 'major'],
    // Prose must not trip it.
    ['Fix: something', 'This is not a breaking change: everything still works.', 'patch'],
  ];

  for (const [subject, body, expected] of cases) {
    assert.equal(classify({ subject, body }).level, expected, `${subject} / ${body}`);
  }
});

test('next-version keeps 1.0.0 a decision rather than a side effect', async () => {
  const { bump } = await import(pathToFileURL(join(REPO, 'scripts/next-version.mjs')).href);

  // While the major is 0, a breaking change is a minor. 0.x already means
  // anything can change, and the alternative is the first `Feat!:` quietly
  // declaring the project 1.0.0.
  assert.equal(bump('0.1.0', 'major'), '0.2.0');
  assert.equal(bump('0.1.0', 'minor'), '0.2.0');
  assert.equal(bump('0.1.0', 'patch'), '0.1.1');
  assert.equal(bump('0.1.0', 'none'), '0.1.0');

  // Past 1.0.0 it is ordinary semver again.
  assert.equal(bump('1.2.3', 'major'), '2.0.0');
  assert.equal(bump('1.2.3', 'minor'), '1.3.0');
  assert.equal(bump('1.2.3', 'patch'), '1.2.4');

  // A prerelease is counted from its release, not from its own suffix.
  assert.equal(bump('1.2.3-main.9', 'patch'), '1.2.4');
});

test('next-version cuts from the tags, and never publishes a rolling build below the last release', () => {
  // Two failures this covers. Describing against `latest` - which is a rolling
  // pointer, not a release - would make every version look already cut. And a
  // rolling prerelease of the *current* version sorts below it, so
  // `npm i @osqd/notifyjs@next` would hand people something older than
  // `@latest`.
  const dir = tmp('nextversion');
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const run = (...args) => {
    const r = spawnSync(
      process.execPath,
      [join(dir, 'scripts/next-version.mjs'), ...args],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(r.status, 0, r.stderr);
    return Object.fromEntries(
      r.stdout.trim().split('\n').map((line) => line.split('=')),
    );
  };

  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(
      join(dir, 'scripts/next-version.mjs'),
      readFileSync(join(REPO, 'scripts/next-version.mjs'), 'utf8'),
    );
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.1.0' }));

    git('init', '-q', '.');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('add', '-A');
    git('commit', '-qm', 'Init');

    // No release tag yet: the first version is what the manifests claim,
    // not a bump away from it.
    let out = run('--github-output');
    assert.equal(out.next, '0.1.0');
    assert.equal(out.level, 'seed');
    assert.equal(out.releasable, 'true');

    git('tag', '-a', 'v0.1.0', '-m', 'first');
    // The rolling tag must not be mistaken for a release.
    git('tag', 'latest');

    git('commit', '-q', '--allow-empty', '-m', 'CI: pin the runner');
    out = run('--github-output');
    assert.equal(out.current, '0.1.0', 'counted from v0.1.0, not from `latest`');
    assert.equal(out.releasable, 'false', 'a CI: commit is not a release');
    assert.equal(out.next, '0.1.0');

    // ...but the build the default branch publishes still needs a version
    // above the one already on npm.
    out = run('--rolling', '--github-output');
    assert.equal(out.next, '0.1.1');

    git('commit', '-q', '--allow-empty', '-m', 'Feat: snooze windows');
    out = run('--github-output');
    assert.equal(out.next, '0.2.0');
    assert.equal(out.tag, 'v0.2.0');
    assert.equal(out.level, 'minor');
    assert.equal(out.releasable, 'true');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('set-version still runs itself from a path that needs URL encoding', () => {
  // Its entry-point check used to compare `import.meta.url` against a raw
  // filesystem path. In a checkout with a space in it the two never matched:
  // the script exited 0 having changed nothing, and the release published
  // packages pointing at a version that was never cut.
  const dir = mkdtempSync(join(tmpdir(), 'notifyjs set version '));
  try {
    const script = join(dir, 'set-version.mjs');
    writeFileSync(script, readFileSync(join(REPO, 'scripts/set-version.mjs'), 'utf8'));
    // No version argument, so a script that recognises itself as the entry
    // point prints usage and exits 1. One that does not, exits 0 in silence.
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(result.status, 1, 'the script must recognise it was run directly');
    assert.match(result.stderr, /usage: set-version/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('pairing-code input formatting has one definition, tied to the code length', async () => {
  // The dashboard, phone and desktop app each carried an identical copy that
  // hardcoded the length, so reshaping a code meant editing four places and
  // being silently wrong in whichever one was missed.
  const { formatPairingCode, PAIRING_CODE_LENGTH, encodePairingCode, isPairingCodeValid } =
    await import('@osqd/notifyjs-protocol');

  assert.equal(formatPairingCode('abcd'), 'ABCD');
  assert.equal(formatPairingCode('abcdefgh'), 'ABCD-EFGH');
  assert.equal(formatPairingCode('abcd-efgh-jkmn'), 'ABCD-EFGH-JKMN');
  assert.equal(formatPairingCode('  a b/c d '), 'ABCD', 'anything not a code character is dropped');

  // The cap comes from the encoding, not from a literal in a UI file.
  const overlong = formatPairingCode('A'.repeat(PAIRING_CODE_LENGTH + 20));
  assert.equal(overlong.replace(/-/g, '').length, PAIRING_CODE_LENGTH);

  // Formatting a real code reproduces exactly what the hub hands out, which is
  // what makes a pasted code match a typed one.
  const issued = encodePairingCode(nodeCrypto.randomBytes(7));
  assert.equal(formatPairingCode(issued), issued);
  assert.ok(isPairingCodeValid(formatPairingCode(issued.toLowerCase())));

  // Every client must be reading it from here rather than keeping its own.
  const copies = [];
  for (const file of [
    'packages/web/src/view.ts',
    'packages/desktop/src/renderer/screens.ts',
    'packages/mobile/src/PairScreen.tsx',
  ]) {
    const code = readFileSync(join(REPO, file), 'utf8');
    if (/\.slice\(0, 12\)/.test(code)) copies.push(file);
  }
  assert.deepEqual(copies, [], 'a client is formatting codes with its own hardcoded length');
});


/* ------------------------------------------------------------------ */
/* Credential durability                                               */
/* ------------------------------------------------------------------ */

test('a credential file survives a write that is interrupted', async () => {
  // The hub's own store writes through a temp file and a rename, because "a
  // crash mid-write leaves the previous store intact". The credential stores
  // wrote directly - and a truncated file there is worse: `load()` cannot
  // parse it, returns nothing, and the device silently loses the private seed
  // that is its identity.
  const { fileStorage } = await import(
    pathToFileURL(join(REPO, 'packages/cli/dist/storage.js')).href
  );

  const dir = tmp('creds');
  const file = join(dir, 'credentials.json');
  const storage = fileStorage(file);

  await storage.set('notifyjs.deviceId', 'dev-1');
  await storage.set('notifyjs.secretSeed', 'a'.repeat(43));
  assert.equal(await storage.get('notifyjs.secretSeed'), 'a'.repeat(43));

  // What an interrupted write leaves behind: a half-written temp file beside
  // the real one. The rename never happened, so the credentials are untouched.
  writeFileSync(`${file}.tmp`, '{"notifyjs.deviceId":"dev-1","notifyjs.sec');

  const reopened = fileStorage(file);
  assert.equal(await reopened.get('notifyjs.deviceId'), 'dev-1', 'identity survives');
  assert.equal(await reopened.get('notifyjs.secretSeed'), 'a'.repeat(43), 'the seed survives');

  // And a later successful write clears the wreckage by replacing the target.
  await reopened.set('notifyjs.publicKey', 'b'.repeat(43));
  assert.equal(await reopened.get('notifyjs.publicKey'), 'b'.repeat(43));
  assert.equal(await reopened.get('notifyjs.secretSeed'), 'a'.repeat(43));

  // The file the process actually reads is never the partial one.
  assert.doesNotThrow(() => JSON.parse(readFileSync(file, 'utf8')));

  rmSync(dir, { recursive: true, force: true });
});


/* ------------------------------------------------------------------ */
/* Dead sockets                                                        */
/* ------------------------------------------------------------------ */

test('a device that stops answering is dropped, and one that answers is kept', async () => {
  // A session is removed on close or error, and a half-open socket produces
  // neither. Until TCP gave up - many minutes, or never on a quiet connection -
  // the hub counted that device as reached and an escalating call rang it.
  const dir = tmp('liveness');
  const hub = new Notifier({
    port: 0,
    storeDir: dir,
    dashboard: false,
    logger: false,
    metrics: true,
    // The resolver floors this at a second, so a sweep is 1s and noticing a
    // silent peer takes two: one to ask, one to find no answer.
    livenessIntervalMs: 1,
    deviceWatchdog: { enabled: false },
    security: { connectionBurst: 500, connectionRefillPerSec: 100, maxConnectionsPerIp: 200 },
  });
  await hub.start();

  const pairClient = async (name, onSocket) => {
    const client = makeClient(hub, name, {
      createSocket: (url) => {
        const ws = new WebSocket(url);
        onSocket?.(ws);
        return ws;
      },
    });
    const ready = new Promise((r) => client.on('ready', r));
    await client.pair(hub.createPairingCode({ role: 'oncall' }).code);
    await ready;
    return client;
  };

  // `ws` answers pings for its owner, so this one stays reachable.
  const healthy = await pairClient('healthy');

  // This one stops reading its socket, which is what a closed laptop lid or a
  // dropped NAT mapping looks like from the hub: nothing is closed, nothing
  // errors, and no pong ever comes back.
  let muteSocket;
  const mute = await pairClient('mute', (ws) => (muteSocket = ws));

  assert.equal(hub.onlineDeviceIds().length, 2, 'both devices are connected');
  muteSocket._socket.pause();

  await new Promise((r) => setTimeout(r, 2600));

  assert.equal(hub.onlineDeviceIds().length, 1, 'the unreachable device is dropped');
  assert.equal(healthy.status, 'ready', 'the reachable one is untouched');

  // Visible to an operator rather than silent, in both places they would look.
  assert.ok(
    hub.auditLog(50).some((e) => e.kind === 'session.unreachable'),
    'the drop is audited',
  );
  const metrics = await (
    await fetch(`${hub.dashboardUrl.replace('localhost', '127.0.0.1')}/metrics`)
  ).text();
  assert.match(metrics, /notifyjs_unreachable_drops_total 1/);
  // Counted apart from a device dropped for refusing to read, which is a
  // different failure with a different fix.
  assert.match(metrics, /notifyjs_stalled_drops_total 0/);

  muteSocket._socket.resume();
  mute.disconnect();
  healthy.disconnect();
  await hub.stop();
  rmSync(dir, { recursive: true, force: true });
});


/* ------------------------------------------------------------------ */
/* Who rings first                                                     */
/* ------------------------------------------------------------------ */

test('an escalating call rings the most recently used device, not the newest connection', async () => {
  // `lastSeenAt` was written only at pair and auth, so among devices that are
  // all connected it recorded who authenticated last. A tablet that had just
  // reconnected after a network blip therefore rang ahead of a phone that had
  // been present and in use all day - the inverse of what the ladder is for.
  const dir = tmp('ringorder');
  const hub = new Notifier({
    port: 0,
    storeDir: dir,
    dashboard: false,
    logger: false,
    defaultRingSeconds: 1,
    security: { connectionBurst: 500, connectionRefillPerSec: 100, maxConnectionsPerIp: 200 },
  });
  await hub.start();

  const join = async (name) => {
    const client = makeClient(hub, name);
    const ready = new Promise((r) => client.on('ready', r));
    await client.pair(hub.createPairingCode({ role: 'oncall' }).code);
    await ready;
    return client;
  };

  const phone = await join('phone');
  const tablet = await join('tablet');

  // A day into normal operation: both have been connected for hours, and the
  // tablet is the *newer* connection because it reconnected more recently.
  const hoursAgo = (h) => Date.now() - h * 60 * 60_000;
  for (const d of hub.devices()) {
    const connected = d.name === 'tablet' ? hoursAgo(0.1) : hoursAgo(8);
    d.lastSeenAt = connected;
    d.lastActiveAt = connected;
  }

  // Then somebody picks up the phone and acknowledges an alert. This is past
  // the touch throttle, so it is recorded.
  const alert = await hub.notify({ title: 'something', channel: 'x', severity: 'warning' });
  phone.ack([alert.id], { seq: alert.seq, action: 'ack' });
  await new Promise((r) => setTimeout(r, 150));

  const byName = Object.fromEntries(hub.devices().map((d) => [d.name, d]));
  assert.ok(
    byName.phone.lastActiveAt > byName.tablet.lastActiveAt,
    'the phone is now the more recently used device',
  );
  // `lastSeenAt` deliberately moved too - the phone was just heard from.
  //
  // Now the tablet is heard from as well, which is what a liveness pong does
  // every interval for any device that is merely switched on. That is what
  // makes `lastSeenAt` useless as an ordering: left to it, the idle tablet
  // would take the first rung purely for having answered a ping most recently.
  const tabletRecord = hub.devices().find((d) => d.name === 'tablet');
  tabletRecord.lastSeenAt = Date.now();

  assert.ok(
    tabletRecord.lastSeenAt >= byName.phone.lastSeenAt,
    'the idle tablet is the most recently *heard from* device',
  );

  // The ladder rings one device per rung, so whoever rings first is the order.
  const rung = [];
  hub.on('call', (e) => {
    if (e.type === 'ringing') rung.push(e.deviceName);
  });
  await hub.call({ message: 'wake up', severity: 'critical', channel: 'x' });

  assert.equal(rung[0], 'phone', 'the device someone was using rings first');

  phone.disconnect();
  tablet.disconnect();
  await hub.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('a connected device does not report a stale "last seen"', async () => {
  // `notifyjs devices` prints this beside an `online` marker, so a device
  // connected right now was showing "last seen" as whenever it had connected.
  const dir = tmp('lastseen');
  const hub = new Notifier({
    port: 0,
    storeDir: dir,
    dashboard: false,
    logger: false,
    security: { connectionBurst: 500, connectionRefillPerSec: 100, maxConnectionsPerIp: 200 },
  });
  await hub.start();

  const client = makeClient(hub, 'desk');
  const ready = new Promise((r) => client.on('ready', r));
  await client.pair(hub.createPairingCode({ role: 'oncall' }).code);
  await ready;

  // Backdate it to what a week-old connection would have looked like.
  const stale = Date.now() - 7 * 24 * 60 * 60_000;
  const store = hub.devices()[0];
  store.lastSeenAt = stale;
  store.lastActiveAt = stale;

  // Any frame from the device refreshes it.
  client.sync();
  await new Promise((r) => setTimeout(r, 150));

  const [device] = hub.devices();
  assert.ok(
    Date.now() - device.lastSeenAt < 5_000,
    `a connected device is seen now, not ${new Date(device.lastSeenAt).toISOString()}`,
  );

  client.disconnect();
  await hub.stop();
  rmSync(dir, { recursive: true, force: true });
});


/* ------------------------------------------------------------------ */
/* Startup                                                             */
/* ------------------------------------------------------------------ */

test('a hub whose port is taken can be started again once it is free', async () => {
  // `started` was set before `listen()`, so after the commonest startup
  // failure there is, the retry hit the early return at the top of `start()`:
  // it resolved, `url` named a plausible address, and nothing was listening.
  // An alerting hub that believes it is up is worse than one that will not
  // start at all.
  const squatter = createServer(() => {});
  await new Promise((r) => squatter.listen(0, '127.0.0.1', r));
  const taken = squatter.address().port;

  const dir = tmp('startfail');
  const hub = new Notifier({
    port: taken,
    host: '127.0.0.1',
    storeDir: dir,
    dashboard: false,
    logger: false,
  });

  await assert.rejects(() => hub.start(), /EADDRINUSE/);

  await new Promise((r) => squatter.close(r));

  // The same instance, started again now the port is free.
  await hub.start();
  const health = await fetch(`${hub.dashboardUrl.replace('localhost', '127.0.0.1')}/health`);
  assert.equal(health.status, 200, 'the retried hub is actually listening');
  assert.equal(new URL(hub.url).port, String(taken), 'and on the port it was asked for');

  await hub.stop();
  rmSync(dir, { recursive: true, force: true });
});


/* ------------------------------------------------------------------ */
/* Restart                                                             */
/* ------------------------------------------------------------------ */

test('a restarted hub is still watching the heartbeats it says it is watching', async () => {
  // The watchdog sweep was armed by `expect()` and `restore()`, both of which
  // run once. `stop()` cleared it and nothing brought it back, so a hub that
  // had been stopped and started went on *listing* its heartbeats while never
  // checking one again. Silence is the entire signal here, so a watchdog that
  // has quietly stopped watching is the worst way for this to fail.
  const dir = tmp('restart-beat');
  const hub = new Notifier({
    port: 0,
    storeDir: dir,
    dashboard: false,
    logger: false,
    heartbeatTickMs: 40,
  });

  const missed = [];
  hub.on('heartbeat:missed', (e) => missed.push(e.heartbeat.name));

  await hub.start();
  // `repeat` so a beat that is already missing keeps reporting - which is what
  // makes "is the sweep running at all" observable.
  hub.expect('nightly-backup', { every: 80, grace: 0, repeat: true });
  await new Promise((r) => setTimeout(r, 350));
  assert.ok(missed.length > 0, 'the sweep runs before a restart');

  missed.length = 0;
  await hub.stop();
  await hub.start();

  assert.deepEqual(
    hub.heartbeats().map((b) => b.name),
    ['nightly-backup'],
    'the hub still reports it is watching',
  );
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(missed.length > 0, 'and it is actually still watching');

  await hub.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('a restarted hub still sweeps stale per-IP state', async () => {
  // Same shape: the guard's sweeper was armed in its constructor only, so
  // after the first restart the map it prunes grew without limit - the leak it
  // exists to prevent, driven by unauthenticated traffic.
  const { Guard } = await import('../dist/index.js');

  const bans = [];
  const fakeStore = {
    ban: () => undefined,
    putBan: (b) => bans.push(b),
    clearBan: () => {},
    bans: () => [],
  };
  const guard = new Guard(
    { maxConnectionsPerIp: 5, connectionBurst: 5, connectionRefillPerSec: 1, maxUnauthenticated: 50 },
    fakeStore,
  );

  const armed = (g) => g.sweeper !== undefined;
  assert.ok(armed(guard), 'armed on construction');

  guard.stop();
  assert.ok(!armed(guard), 'stopped');

  guard.start();
  assert.ok(armed(guard), 'and can be armed again');

  // Idempotent, so a double start does not leave an orphaned interval.
  const first = guard.sweeper;
  guard.start();
  assert.equal(guard.sweeper, first, 'starting twice keeps one timer');

  guard.stop();
});


test('a store that had to be started over says so', async () => {
  // The worst thing that can happen to a hub was completely silent. The
  // serverId is part of every auth signature, so a store that cannot be parsed
  // means every paired device fails to authenticate at once - and nothing
  // anywhere connected the outage to its cause or pointed at the salvage.
  const dir = tmp('corrupt-report');
  writeFileSync(join(dir, 'store.json'), '{ this is not json');

  const lines = [];
  const hub = new Notifier({
    port: 0,
    storeDir: dir,
    dashboard: false,
    logger: (line, meta) => lines.push({ line, meta }),
  });
  await hub.start();

  const told = lines.find((l) => /started over/.test(l.line));
  assert.ok(told, 'the operator is told the store was reset');
  assert.match(told.meta.keptAt, /store\.json\.corrupt-\d+$/, 'and where the old one went');
  assert.ok(existsSync(told.meta.keptAt), 'which is a file that exists');

  // And it is in the audit log, where an operator looks after the fact.
  assert.ok(
    hub.auditLog(50).some((e) => e.kind === 'store.recovered'),
    'the reset is audited',
  );

  await hub.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('a healthy store reports no recovery', () => {
  // The other half: this must not cry wolf on an ordinary boot, or the message
  // stops meaning anything.
  const dir = tmp('clean-store');
  const first = new Store(dir, { history: 10, audit: 10 }, () => 'server-1');
  assert.equal(first.recoveredFrom, undefined, 'a fresh store has not recovered');
  first.close();

  const second = new Store(dir, { history: 10, audit: 10 }, () => 'server-2');
  assert.equal(second.recoveredFrom, undefined, 'nor has one that reopened cleanly');
  assert.equal(second.serverId, 'server-1', 'and the identity every device signs against is kept');
  second.close();

  rmSync(dir, { recursive: true, force: true });
});


/* ------------------------------------------------------------------ */
/* Delivery decisions                                                  */
/* ------------------------------------------------------------------ */

/**
 * A slow, obviously-correct reference for `*` globbing.
 *
 * `channelMatches` is deliberately iterative rather than a compiled regex, to
 * avoid the exponential backtracking a pattern like `a*a*a*a*b` provokes. That
 * hand-written matcher is the single thing standing between a role's channel
 * list and what a device is shown, so it is checked against a version whose
 * only virtue is being easy to read.
 */
function referenceGlob(pattern, value) {
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();
  const walk = (pi, vi) => {
    if (pi === p.length) return vi === v.length;
    if (p[pi] === '*') {
      for (let k = vi; k <= v.length; k++) if (walk(pi + 1, k)) return true;
      return false;
    }
    return vi < v.length && p[pi] === v[vi] && walk(pi + 1, vi + 1);
  };
  return walk(0, 0);
}

test('channel matching agrees with a reference implementation', async () => {
  const { channelMatches } = await import('@osqd/notifyjs-protocol');

  const alphabet = ['a', 'b', '.', '*'];
  const pick = (n) =>
    Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');

  const mismatches = [];
  for (let i = 0; i < 20_000; i++) {
    const pattern = pick(Math.floor(Math.random() * 7));
    const value = pick(Math.floor(Math.random() * 7)).replace(/\*/g, 'c');
    if (channelMatches([pattern], value) !== referenceGlob(pattern, value)) {
      mismatches.push({ pattern, value });
      if (mismatches.length > 4) break;
    }
  }
  assert.deepEqual(mismatches, [], 'the fast matcher must agree with the readable one');
});

test('a pathological channel pattern cannot pin the event loop', async () => {
  const { channelMatches } = await import('@osqd/notifyjs-protocol');

  // The shape that makes a backtracking regex hang. A role is editable over
  // the wire and is consulted on every single delivery, so one of these must
  // not be able to stall the fan-out.
  const started = Date.now();
  channelMatches(['a*a*a*a*a*a*a*b'], 'a'.repeat(64));
  assert.ok(Date.now() - started < 250, 'matching stays linear');
});

test('a malformed role denies delivery rather than throwing', async () => {
  const { channelMatches, canDeliver } = await import('@osqd/notifyjs-protocol');

  // `roles.upsert` is reachable over the wire and the result runs inside the
  // delivery loop: a throw there would take every later notification with it.
  for (const channels of [undefined, null, 'not-an-array', 42, [null, 7, {}]]) {
    assert.equal(channelMatches(channels, 'x'), false, `channels=${JSON.stringify(channels)}`);
  }

  assert.equal(
    canDeliver({
      role: { name: 'broken', channels: undefined, minSeverity: undefined, capabilities: undefined },
      deviceId: 'd1',
      channel: 'x',
      severity: 'critical',
    }),
    false,
    'a role with nothing valid on it delivers nothing',
  );
});

test('quiet hours wrap past midnight', async () => {
  const { inQuietHours } = await import('@osqd/notifyjs-protocol');
  const at = (h) => new Date(2026, 0, 1, h, 0, 0);

  const overnight = { start: 22, end: 7 };
  assert.equal(inQuietHours(overnight, at(23)), true, 'before midnight');
  assert.equal(inQuietHours(overnight, at(3)), true, 'after midnight');
  assert.equal(inQuietHours(overnight, at(12)), false, 'the middle of the day is not quiet');

  const daytime = { start: 9, end: 17 };
  assert.equal(inQuietHours(daytime, at(12)), true);
  assert.equal(inQuietHours(daytime, at(20)), false);
});


/* ------------------------------------------------------------------ */
/* Adversarial                                                         */
/* ------------------------------------------------------------------ */

/** A socket speaking the wire protocol by hand, for things a client will not do. */
function rawSocket(hub) {
  return new Promise((resolve) => {
    const ws = new WebSocket(hub.url.replace('localhost', '127.0.0.1'));
    const queue = [];
    let waiting;
    ws.on('message', (m) => {
      const frame = JSON.parse(m.toString());
      if (waiting) {
        waiting(frame);
        waiting = undefined;
      } else queue.push(frame);
    });
    ws.on('open', () =>
      resolve({
        ws,
        send: (o) => ws.send(JSON.stringify(o)),
        next: () =>
          queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => (waiting = r)),
      }),
    );
  });
}

function hostileHub(dir, extra = {}) {
  return new Notifier({
    port: 0,
    storeDir: dir,
    dashboard: false,
    logger: false,
    security: {
      uniformFailureMs: 1,
      connectionBurst: 5000,
      connectionRefillPerSec: 1000,
      maxConnectionsPerIp: 500,
      maxFailuresBeforeBan: 1000,
      messageRate: { points: 10_000, windowMs: 10_000 },
    },
    ...extra,
  });
}

async function pairRaw(hub, role, label) {
  const { canonical, SIG_PAIR, normalizePairingCode } = await import('@osqd/notifyjs-protocol');
  const code = normalizePairingCode(hub.createPairingCode({ role }).code);
  const keys = await nodeCrypto.generateKeyPair();
  const c = await rawSocket(hub);
  const hello = await c.next();
  const frame = {
    v: 1,
    t: 'pair',
    code,
    publicKey: keys.publicKey,
    name: label,
    platform: 'test',
    sig: await nodeCrypto.sign(
      keys,
      canonical([SIG_PAIR, hello.serverId, hello.nonce, code, keys.publicKey, label, 'test']),
    ),
  };
  c.send(frame);
  const paired = await c.next();
  await c.next(); // ready
  c.deviceId = paired.deviceId;
  c.frame = frame;
  c.ask = async (op, args) => {
    c.send({ v: 1, t: 'admin', id: `${op}-${Math.random()}`, op, args });
    let r;
    do {
      r = await c.next();
    } while (r.t !== 'admin.result');
    return r;
  };
  return c;
}

test('a captured pair frame cannot be replayed on a new connection', async () => {
  // The auth transcript is covered elsewhere; the pair transcript is the one
  // that enrols a brand new key, so a replay of it is an attacker adding their
  // own device rather than resuming an existing one.
  const dir = tmp('replay-pair');
  const hub = hostileHub(dir);
  await hub.start();

  const first = await pairRaw(hub, 'admin', 'genuine');
  first.ws.close();

  const attacker = await rawSocket(hub);
  await attacker.next(); // a fresh nonce, which the captured signature predates
  attacker.send(first.frame);
  const reply = await attacker.next();

  assert.equal(reply.t, 'error', 'the replayed frame is refused');
  assert.equal(hub.devices().length, 1, 'and no second device was enrolled');

  attacker.ws.close();
  await hub.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('two sockets racing one single-use code enrol exactly one device', async () => {
  // Redemption spans an await while the signature is verified, so the decrement
  // has to happen before that gap - otherwise both sockets see `usesLeft: 1`.
  const { canonical, SIG_PAIR, normalizePairingCode } = await import('@osqd/notifyjs-protocol');
  const dir = tmp('code-race');
  const hub = hostileHub(dir);
  await hub.start();

  const code = normalizePairingCode(hub.createPairingCode({ role: 'admin', uses: 1 }).code);
  const attempt = async (label) => {
    const keys = await nodeCrypto.generateKeyPair();
    const c = await rawSocket(hub);
    const hello = await c.next();
    c.send({
      v: 1,
      t: 'pair',
      code,
      publicKey: keys.publicKey,
      name: label,
      platform: 'test',
      sig: await nodeCrypto.sign(
        keys,
        canonical([SIG_PAIR, hello.serverId, hello.nonce, code, keys.publicKey, label, 'test']),
      ),
    });
    const reply = await c.next();
    c.ws.close();
    return reply.t;
  };

  const outcomes = await Promise.all([attempt('a'), attempt('b')]);
  assert.equal(outcomes.filter((t) => t === 'paired').length, 1, 'exactly one wins');
  assert.equal(hub.devices().length, 1, 'and the store holds one device');

  await hub.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('names that would touch Object.prototype are refused everywhere they are keys', async () => {
  // Tested through a genuine admin: a viewer is refused for lacking the
  // capability, which would pass this test without exercising the name guard
  // at all.
  const dir = tmp('proto-names');
  const hub = hostileHub(dir);
  await hub.start();
  const admin = await pairRaw(hub, 'admin', 'boss');

  for (const name of ['__proto__', 'constructor', 'prototype']) {
    const role = await admin.ask('roles.upsert', { name, channels: ['*'], capabilities: [] });
    assert.equal(role.ok, false, `role named ${name}`);
    assert.match(role.error, /cannot be used/);
  }
  for (const name of ['__proto__', 'constructor']) {
    const beat = await admin.ask('heartbeat.expect', { name, every: '1h' });
    assert.equal(beat.ok, false, `heartbeat named ${name}`);
  }
  const policy = await admin.ask('policies.upsert', { name: '__proto__', steps: [{}] });
  assert.equal(policy.ok, false, 'policy named __proto__');

  assert.equal({}.channels, undefined, 'Object.prototype is untouched');
  assert.equal({}.every, undefined);
  assert.equal({}.steps, undefined);
  // And nothing was half-registered on the way to being refused.
  assert.deepEqual(hub.heartbeats(), []);
  assert.deepEqual(hub.policies(), []);

  admin.ws.close();
  await hub.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('a snooze quiets noise but cannot switch the pager off', async () => {
  const dir = tmp('snooze');
  const hub = hostileHub(dir);
  await hub.start();
  const device = await pairRaw(hub, 'oncall', 'pager');

  const seen = [];
  device.ws.on('message', (m) => {
    const f = JSON.parse(m.toString());
    if (f.t === 'notification') seen.push(f.n.severity);
  });

  device.send({ v: 1, t: 'snooze', untilMs: Date.now() + 60_000 });
  await new Promise((r) => setTimeout(r, 150));
  await hub.notify({ title: 'noise', severity: 'warning', channel: 'x' });
  await hub.notify({ title: 'fire', severity: 'critical', channel: 'x' });
  await new Promise((r) => setTimeout(r, 300));

  assert.ok(!seen.includes('warning'), 'the warning is held back');
  assert.ok(seen.includes('critical'), 'the critical still arrives');

  // A device asking to be silent for a year gets a day.
  device.send({ v: 1, t: 'snooze', untilMs: Date.now() + 365 * 24 * 3600_000 });
  await new Promise((r) => setTimeout(r, 200));
  const record = hub.devices().find((d) => d.id === device.deviceId);
  assert.ok(
    (record.snoozedUntil - Date.now()) / 86_400_000 <= 1.01,
    'a snooze is a nap, not an off switch',
  );

  device.ws.close();
  await hub.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('a forged X-Forwarded-For is not an identity while trustProxy is off', async () => {
  // The header is client-supplied. Honoured unconditionally it would let one
  // peer invent a new identity per request and walk past every ban ever issued.
  const dir = tmp('xff');
  const hub = hostileHub(dir);
  await hub.start();

  const ws = new WebSocket(hub.url.replace('localhost', '127.0.0.1'), {
    headers: { 'x-forwarded-for': '10.9.9.9' },
  });
  await new Promise((r) => ws.on('open', r));
  // Provoke an audited failure so an IP is recorded.
  ws.send(JSON.stringify({ v: 1, t: 'pair', code: 'AAAA-AAAA-AAAA', publicKey: 'x' }));
  await new Promise((r) => setTimeout(r, 250));

  const ips = new Set(hub.auditLog(30).map((e) => e.ip).filter(Boolean));
  assert.ok(!ips.has('10.9.9.9'), `the header was believed: ${[...ips].join(',')}`);

  ws.close();
  await hub.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('demoting a device takes effect without waiting for it to reconnect', async () => {
  const dir = tmp('demote');
  const hub = hostileHub(dir);
  await hub.start();
  const device = await pairRaw(hub, 'admin', 'demoted');

  assert.equal((await device.ask('audit.tail', {})).ok, true, 'admin may read the log');

  hub.setDeviceRole(device.deviceId, 'viewer');
  await new Promise((r) => setTimeout(r, 150));

  const after = await device.ask('audit.tail', {});
  assert.equal(after.ok, false, 'the live session loses the capability at once');
  assert.equal(after.error, 'forbidden');

  device.ws.close();
  await hub.stop();
  rmSync(dir, { recursive: true, force: true });
});
