import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  // 30s, not 20: a command that cannot reach a hub gives up on its own after the
  // client's 15-second handshake timeout, and the exit-code assertions depend on
  // that happening rather than on this kill - which left about four seconds of
  // margin on a loaded machine.
  return run(process.execPath, [BIN, ...args], { timeout: 30_000 });
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
  // Every command `main()` dispatches, so a command added or renamed without a
  // line in the help text fails here. Eight of the seventeen were checked before,
  // which let five be deleted from the help with the suite still green.
  const commands = [
    'serve', 'listen', 'pair', 'send', 'call', 'devices', 'code', 'cert',
    'export', 'import', 'token', 'watch', 'checkin', 'watches', 'update',
  ];
  for (const command of commands) {
    assert.match(stdout, new RegExp(`notifyjs ${command}\\b`), `${command} is documented`);
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

test('--no-qr leaves the QR out', async () => {
  // Strict parsing used to refuse the documented flag outright.
  const { stdout } = await cli(['code', '--no-qr', '--url', HUB_URL, '--store', creds]);
  assert.match(stdout, /[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/);
  assert.ok(!/[▀▄█]/.test(stdout), 'no QR code is printed');
});

test('token revoke takes its id after the flags', async () => {
  const created = await cli(['token', 'create', '--label', 'ci', '--url', HUB_URL, '--store', creds]);
  const id = /id: (\S+)/.exec(created.stderr)?.[1];
  assert.ok(id, 'the token id is printed');

  // The id used to be read from the first argument, which here is `--url`.
  const revoked = await cli(['token', 'revoke', '--url', HUB_URL, '--store', creds, id]);
  assert.equal(revoked.stdout, `revoked ${id}\n`);
  assert.ok(hub.ingestTokens().find((t) => t.id === id).revokedAt, 'the hub revoked it');
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

test('an export over a file that already exists is still kept to 0600', async (t) => {
  // `writeFileSync`'s `mode` is only honoured when the write creates the file.
  // Exporting over a path that already existed - touched beforehand, left by an
  // earlier run, checked out of a repository - kept whatever permissions it had,
  // usually 0644, with the hub's signing key and every device secret in it.
  if (process.platform === 'win32') {
    t.skip('POSIX modes only');
    return;
  }

  const out = join(dir, 'backup.json');
  writeFileSync(out, 'from an earlier run\n');
  chmodSync(out, 0o644);

  await cli(['export', '--data', join(dir, 'hub'), '--out', out]);

  assert.equal((statSync(out).mode & 0o777).toString(8), '600', 'nobody else can read it');
});

test('a misspelled severity is refused rather than quietly downgraded', async () => {
  // The hub coerces an unrecognised severity to a default and says nothing,
  // which is right for a frame off the wire and wrong for a flag somebody
  // typed: `--severity crittical` went out at `info`, under the floor every
  // on-call role filters on, and exited 0 as though somebody had been paged.
  await assert.rejects(
    () =>
      cli([
        'send', 'the database is down', '--severity', 'crittical',
        '--url', HUB_URL, '--store', creds,
      ]),
    (err) => {
      assert.match(err.stderr, /--severity must be one of/);
      return true;
    },
  );

  assert.ok(
    !hub.history().some((n) => n.title === 'the database is down'),
    'and nothing was sent at the wrong severity',
  );
});

test('bad arguments exit 2, while a failure to do the work exits 1', async () => {
  // The exit code is what a script reads: a wrapper that retries on 1 and gives
  // up on 2 could not tell a typo from an outage, because everything exited 1.
  const codeOf = async (args) => {
    try {
      await cli(args);
      return 0;
    } catch (err) {
      return err.code;
    }
  };

  assert.equal(await codeOf(['send']), 2, 'no title at all');
  assert.equal(await codeOf(['send', 'x', '--severity', 'nope']), 2, 'a severity that is not one');
  // But the same word in a different case is not a mistake, and the hub forgives it
  // too - refusing it here while the hub accepted it left the two disagreeing.
  assert.equal(
    await codeOf(['send', 'shouted', '--severity', 'ERROR', '--url', HUB_URL, '--store', creds]),
    0,
    'CASE is the same severity',
  );
  assert.equal(await codeOf(['serve', '--port', 'http']), 2, 'a port that is not a number');
  assert.equal(await codeOf(['send', 'x', '--nonsense']), 2, 'a flag nobody defined');
  assert.equal(await codeOf(['import']), 2, 'a required flag left off');
  // A flag this file passes straight through, refused by the hub rather than here.
  // These exited 1, so the one class of mistake a wrapper can do nothing about
  // looked like the outage it should retry.
  assert.equal(
    await codeOf(['serve', '--data', join(dir, 'exits'), '--web-push-subject', 'ops@example.com']),
    2,
    'a VAPID subject that is not a URI',
  );
  assert.equal(
    await codeOf(['serve', '--data', join(dir, 'exits'), '--port', '70000']),
    2,
    'a port past the last one',
  );

  // Unchanged: an unknown command is a failing check, not a malformed one.
  assert.equal(await codeOf(['wat']), 1);
  // And so is work that could not be done - here, a hub that is not there.
  assert.equal(
    await codeOf(['devices', '--url', 'ws://127.0.0.1:1', '--store', join(dir, 'absent.json')]),
    1,
  );
});

test('a damaged credential file is kept, not silently replaced', async () => {
  // `load()` returned `{}` for a file it could not parse, so the device looked
  // unpaired against every hub - and the re-pair that naturally follows wrote a
  // file holding only the new key, destroying the private seeds for all the
  // others. A zero-byte file is reachable: neither store fsyncs before the
  // rename, so a power loss can leave one.
  for (const [name, contents] of [
    ['damaged.json', '{ this is not json'],
    ['nulled.json', 'null'],
  ]) {
    const store = join(dir, name);
    writeFileSync(store, contents);

    const { code } = hub.createPairingCode({ role: 'viewer' });
    const paired = await cli(['pair', code, '--url', HUB_URL, '--store', store, '--name', 'again']);
    assert.match(paired.stdout, /paired as "again"/, `${name}: pairing still works`);

    const kept = readdirSync(dir).filter((f) => f.startsWith(`${name}.corrupt-`));
    assert.equal(kept.length, 1, `${name}: the old file was kept`);
    assert.equal(readFileSync(join(dir, kept[0]), 'utf8'), contents, `${name}: keys preserved`);
    assert.match(paired.stderr, /has been kept at/, `${name}: and the operator is told`);
  }
});
