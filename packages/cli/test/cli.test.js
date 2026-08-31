import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Notifier } from '@osqd/notifyjs';

const run = promisify(execFile);
const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/bin.js');
/**
 * Chosen by the OS, not by this file. Fixed ports made the suite fail in
 * bursts whenever a port was still held from an earlier run - every test in
 * the file at once, for a reason that had nothing to do with the code.
 */
let PORT = 0;
/** Assigned in `before`, once the hub has told us which port it got. */
let HUB_URL = '';

let hub;
let dir;
let creds;

/** Runs the CLI the way a user would, as a separate process. */
function cli(args) {
  return run(process.execPath, [BIN, ...args], { timeout: 20_000 });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'notifyjs-cli-'));
  creds = join(dir, 'creds.json');
  hub = new Notifier({
    port: 0,
    storeDir: join(dir, 'hub'),
    dashboard: false,
    logger: false,
    security: { connectionBurst: 500, connectionRefillPerSec: 100, maxConnectionsPerIp: 200 },
  });
  await hub.start();
  PORT = Number(new globalThis.URL(hub.url).port);
  HUB_URL = `ws://127.0.0.1:${PORT}`;
});

after(async () => {
  await hub?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('help lists the commands', async () => {
  const { stdout } = await cli(['help']);
  for (const command of ['serve', 'listen', 'pair', 'send', 'call', 'devices', 'code', 'cert']) {
    assert.match(stdout, new RegExp(`notifyjs ${command}`), `${command} is documented`);
  }
});

test('an unknown command fails loudly', async () => {
  await assert.rejects(
    () => cli(['wat']),
    (err) => {
      assert.match(err.stderr, /unknown command: wat/);
      return true;
    },
  );
});

test('a malformed pairing code is rejected before it reaches the hub', async () => {
  // The checksum is verified locally, so this must not spend an attempt
  // against the hub's rate limiter.
  await assert.rejects(
    () => cli(['pair', 'AAAA-AAAA-AAAA', '--url', HUB_URL, '--store', creds]),
    (err) => {
      assert.match(err.stderr, /malformed/);
      return true;
    },
  );
});

test('pair, then send and list devices through the hub', async () => {
  const { code } = hub.createPairingCode({ role: 'admin' });

  const paired = await cli(['pair', code, '--url', HUB_URL, '--store', creds, '--name', 'ci-box']);
  assert.match(paired.stdout, /paired as "ci-box" with role admin/);

  const sent = await cli([
    'send', 'Backup complete', '--body', '1.2 GB', '--severity', 'success',
    '--url', HUB_URL, '--store', creds,
  ]);
  assert.match(sent.stdout, /sent/);

  const listed = await cli(['devices', '--url', HUB_URL, '--store', creds]);
  assert.match(listed.stdout, /ci-box\s+admin\s+active/);

  assert.ok(
    hub.history().some((n) => n.title === 'Backup complete'),
    'the hub recorded the notification',
  );
});

test('minting a code prints a scannable QR alongside it', async () => {
  const { stdout } = await cli(['code', '--role', 'oncall', '--url', HUB_URL, '--store', creds]);
  assert.match(stdout, /[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/);
  assert.match(stdout, /role: oncall/);
  // Half-block glyphs mean a QR was actually rendered.
  assert.ok(/[▀▄█]/.test(stdout), 'a QR code is printed');
});

test('a device without permission cannot send', async () => {
  const viewerCreds = join(dir, 'viewer.json');
  const { code } = hub.createPairingCode({ role: 'viewer' });
  await cli(['pair', code, '--url', HUB_URL, '--store', viewerCreds, '--name', 'viewer-box']);

  await assert.rejects(
    () => cli(['send', 'nope', '--url', HUB_URL, '--store', viewerCreds]),
    (err) => {
      assert.match(err.stderr, /forbidden/);
      return true;
    },
  );
});

test('serve refuses half a TLS configuration', async () => {
  await assert.rejects(
    () => cli(['serve', '--tls-cert', '/tmp/nope.pem']),
    (err) => {
      assert.match(err.stderr, /--tls-cert and --tls-key must be given together/);
      return true;
    },
  );
});
