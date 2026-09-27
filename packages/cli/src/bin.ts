#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { hostname, networkInterfaces } from 'node:os';
import { createInterface } from 'node:readline/promises';
import WebSocket from 'ws';

import {
  Notifier,
  OptionError,
  backupSecrets,
  hubHolding,
  exportStore,
  formatDuration,
  importStore,
  isBackup,
  type Severity,
} from '@osqd/notifyjs';
import { NotifyClient, SEVERITIES, isPairingCodeValid, isSeverity } from '@osqd/notifyjs-protocol';
import { nodeCrypto } from '@osqd/notifyjs-protocol/node';

import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { fileStorage, defaultPath } from './storage.js';
import { generateSelfSigned } from './cert.js';
import { apply as applyUpdate, check as checkUpdate } from './selfupdate.js';
import { desktopNotify, printNotification, safeText, speakCall } from './desktop.js';

const HELP = `notifyjs - self-hosted notifications for your own devices

Usage
  notifyjs serve [options]        Run a standalone hub
  notifyjs listen [options]       Connect this machine as a device
  notifyjs pair <code> [options]  Pair this machine using a code
  notifyjs send <title> [options] Send a notification through a paired hub
  notifyjs call <message>         Ring the on-call devices and speak a message
  notifyjs devices                List devices known to the hub
  notifyjs code [options]         Mint a pairing code (requires an admin device)
  notifyjs token <cmd> [options]  Manage HTTP publishing tokens (create/list/revoke)
  notifyjs export [options]       Write this hub's state to a backup file
  notifyjs import --from <file>   Restore a hub from a backup file
  notifyjs cert [options]         Generate a self-signed TLS certificate
  notifyjs watch <name> [options] Expect a check-in, and alert when it stops
  notifyjs checkin <name>         Record a check-in for a watched job
  notifyjs watches                List what the hub is expecting
  notifyjs update [options]       Check for and install a newer build

Common options
  --url <ws://host:7741>   Hub to connect to (default $NOTIFYJS_URL, else ws://localhost:7741)
  --store <path>           Credential file (default ${defaultPath()})
  --name <name>            Name to register this device under

serve options
  --port <n>               Port to listen on (default 7741)
  --host <addr>            Bind address (default 0.0.0.0)
  --hub-name <name>        Name devices see when pairing
  --data <dir>             Hub state directory (default .notifyjs)
  --no-dashboard           Do not serve the web dashboard
  --dashboard-dir <dir>    Serve dashboard assets from this directory
                           (or $NOTIFYJS_DASHBOARD_DIR)
  --public-url <url>       Address devices should use (default: your LAN IP)
  --tls-cert <file>        Certificate for wss:// (see: notifyjs cert)
  --tls-key <file>         Private key for wss://
  --no-qr                  Do not print a QR code for the pairing link
  --ingest                 Accept alerts over HTTP from token holders
  --ingest-insecure        Allow ingest tokens over plain HTTP from off-box
  --no-web-push            Do not send encrypted pushes to browsers
  --web-push-body          Include the alert body in the encrypted push
  --web-push-subject <uri> mailto: or https: URI identifying you to a push
                           service (required by RFC 8292)
  --admin-code             Also print an admin pairing code on start

cert options
  --out <dir>              Where to write the certificate (default .notifyjs)
  --host <name>            Extra hostname or IP to include (repeatable)

code options
  --role <name>            Role the code grants (default viewer)
  --uses <n>               Times the code may be redeemed (default 1)
  --ttl <seconds>          Lifetime of the code (default 600)
  --no-qr                  Do not print a QR code

send options
  --severity <level>       debug|info|success|warning|error|critical
  --channel <name>         Channel to publish on (default default)
  --body <text>            Longer body text

call options
  --severity <level>       debug|info|success|warning|error|critical
  --channel <name>         Channel to publish on (default default)

token options
  --role <name>            Role a created token publishes with (default viewer)
  --label <text>           What it is for, so two tokens can be told apart
  --id <id>                Which token to revoke (or give the id as an argument)

export / import options
  --data <dir>             Hub state directory (default .notifyjs)
  --out <file>             Write the backup here rather than to stdout
  --from <file>            Backup to restore
  --history                Include the alert and audit logs
  --force                  Replace an existing store, history or audit log

update options
  --check                  Report what is available without installing
  --prerelease             Include the rolling "latest" build from main
  --repo <owner/name>      Source repository (default OSQD-ts/NotifyJS)

watch options
  --every <duration>       How often a check-in is expected, e.g. 24h
  --grace <duration>       Extra slack before it counts as missed
  --severity <level>       Severity of the alert raised (default critical)
  --description <text>     Shown in the alert body

Put "notifyjs checkin <name>" at the end of a cron job and the hub will tell
you when that job stops running - the one alert a dead process cannot send
for itself.
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case 'serve':
      return serve(rest);
    case 'listen':
      return listen(rest);
    case 'pair':
      return pair(rest);
    case 'send':
      return send(rest);
    case 'call':
      return placeCall(rest);
    case 'devices':
      return devices(rest);
    case 'export':
      return await backup(['export', ...rest]);
    case 'import':
      return await backup(['import', ...rest]);
    case 'token':
      return await token(rest);
    case 'code':
      return code(rest);
    case 'cert':
      return cert(rest);
    case 'watch':
      return watch(rest);
    case 'checkin':
      return checkin(rest);
    case 'watches':
      return watches(rest);
    case 'update':
      return update(rest);
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      process.stdout.write(HELP);
      return;
    default:
      process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

/* ------------------------------------------------------------------ */
/* serve                                                               */
/* ------------------------------------------------------------------ */

async function serve(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      'hub-name': { type: 'string' },
      data: { type: 'string' },
      dashboard: { type: 'boolean', default: true },
      'dashboard-dir': { type: 'string' },
      'admin-code': { type: 'boolean', default: false },
      'public-url': { type: 'string' },
      'tls-cert': { type: 'string' },
      'tls-key': { type: 'string' },
      qr: { type: 'boolean', default: true },
      'web-push': { type: 'boolean', default: true },
      'web-push-subject': { type: 'string' },
      'web-push-body': { type: 'boolean', default: false },
      ingest: { type: 'boolean', default: false },
      'ingest-insecure': { type: 'boolean', default: false },
    },
    allowNegative: true,
  });

  // Both halves or neither: a certificate without its key would fail deep
  // inside the TLS server with a far less helpful message.
  const certFile = values['tls-cert'];
  const keyFile = values['tls-key'];
  if (Boolean(certFile) !== Boolean(keyFile)) {
    throw new UsageError('--tls-cert and --tls-key must be given together');
  }

  const hub = new Notifier({
    port: values.port === undefined ? undefined : port(values.port),
    host: values.host,
    name: values['hub-name'],
    storeDir: values.data,
    dashboard: values.dashboard,
    // Publishing over HTTP. Off unless asked for: it is the one way into this
    // hub that does not sign a per-connection nonce, so it should never appear
    // because somebody accepted a default.
    ingest: {
      enabled: values.ingest,
      allowInsecure: values['ingest-insecure'],
    },
    webPush: {
      enabled: values['web-push'],
      ...(values['web-push-subject'] ? { subject: values['web-push-subject'] } : {}),
      includeBody: values['web-push-body'],
    },
    dashboardDir: values['dashboard-dir'],
    publicUrl: values['public-url'],
    tls:
      certFile && keyFile
        ? { cert: readFileSync(certFile), key: readFileSync(keyFile) }
        : undefined,
  });

  await hub.start();

  // A brand-new hub has no devices and no way to reach one, so it offers a
  // first admin code rather than leaving the operator to guess.
  if (values['admin-code'] || hub.devices().length === 0) {
    const issued = hub.createPairingCode({ role: 'admin', ttlMs: 15 * 60_000 });
    // Scanning beats typing a twelve-character code and a LAN address into a
    // phone, so lead with the QR and keep the code as the fallback.
    if (values.qr) process.stdout.write(`\n${issued.qr.terminal}\n`);
    // Both of these used to be printed whatever the hub was actually doing, so
    // `--no-qr` said "scan the code above" with no code above it, and a hub whose
    // dashboard assets are not installed - which it says on the line before - told
    // the operator to open that dashboard in a browser. Following either one gets
    // nothing, which is a poor first five minutes.
    process.stdout.write(
      (values.qr
        ? `\n  Scan the code above with the NotifyJS app, or pair manually:\n\n`
        : `\n  Pair a device with:\n\n`) +
        `      code: ${issued.code}    role: ${issued.role}\n` +
        `      hub:  ${hub.publicUrl}\n\n` +
        (hub.servesDashboard
          ? `  In a browser, open ${hub.dashboardUrl} and enter the code.\n`
          : '') +
        `  Valid for 15 minutes, one use.\n\n`,
    );
  }

  // Best effort and never blocking: a hub must start whether or not GitHub is
  // reachable, and an update notice is not worth delaying an alert path for.
  void checkUpdate({ repository: DEFAULT_REPO, currentVersion: VERSION })
    .then((result) => {
      if (result.available && result.latest) {
        process.stdout.write(
          `\n  a newer build is available: ${result.latest.tag} (run "notifyjs update")\n\n`,
        );
      }
    })
    .catch(() => {});

  hub.on('device:paired', (d) => process.stdout.write(`paired: ${d.name} (${d.role})\n`));
  hub.on('banned', (b) =>
    process.stdout.write(`banned ${b.ip} until ${new Date(b.until).toLocaleTimeString()}\n`),
  );

  onShutdown(() => hub.stop());
}

/**
 * Runs `close` once, on either signal, then exits.
 *
 * Both signals, because a supervisor sends SIGTERM: systemd and launchd both
 * do, and a command that listens only for SIGINT is killed outright when the
 * service is stopped, with no chance to say goodbye. Once, because the two can
 * arrive together and a second pass would race the first one's exit.
 */
function onShutdown(close: () => void | Promise<void>): void {
  let closing = false;
  const handle = () => {
    if (closing) return;
    closing = true;
    void (async () => {
      try {
        await close();
      } finally {
        process.exit(0);
      }
    })();
  };
  process.on('SIGINT', handle);
  process.on('SIGTERM', handle);
}

/**
 * A TCP port, or a clear complaint.
 *
 * `Number('http')` is NaN, which `listen()` then treats as "any free port" -
 * so a typo produced a hub that started successfully on a port nobody asked
 * for and no device could be told about.
 */
function port(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new UsageError(`--port must be a number between 0 and 65535, not "${value}"`);
  }
  return n;
}

/**
 * Something wrong with what was typed, as opposed to something that went wrong.
 *
 * Kept apart because the exit code is what a script reads: 1 means a check
 * failed or the work did not succeed, 2 means the invocation itself was no good.
 * A wrapper retrying on 1 and giving up on 2 cannot tell the difference
 * otherwise, and everything here used to exit 1.
 */
class UsageError extends Error {}

/**
 * A severity, or a clear complaint. Same reasoning as `port`.
 *
 * The hub coerces an unrecognised severity to a default and says nothing, which
 * is right for a frame from the wire and wrong for a flag somebody typed:
 * `--severity crittical` sent the alert at `info`, below the floor every
 * on-call role filters on, and exited 0 as though it had paged somebody.
 */
function severity(value: string | undefined, fallback: Severity): Severity {
  if (value === undefined) return fallback;
  // Case and surrounding space forgiven, exactly as the hub forgives them: `--severity
  // CRITICAL` is the same word, and refusing it here while the hub accepts it left the
  // two disagreeing about the same input.
  const tidied = value.trim().toLowerCase();
  if (!isSeverity(tidied)) {
    throw new UsageError(`--severity must be one of ${SEVERITIES.join(', ')}, not "${value}"`);
  }
  return tidied;
}

/** A positive whole number, or a clear complaint. Same reasoning as `port`. */
function count(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new UsageError(`${flag} must be a positive number, not "${value}"`);
  }
  return Math.floor(n);
}

/* ------------------------------------------------------------------ */
/* device commands                                                     */
/* ------------------------------------------------------------------ */

interface CommonOptions {
  url: string;
  store: string;
  name: string;
}

function common(argv: string[], extra: Record<string, { type: 'string' | 'boolean' }> = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string' },
      store: { type: 'string' },
      name: { type: 'string' },
      ...extra,
    } as never,
    allowPositionals: true,
    // `--no-qr` is documented for `code`; strict parsing refused it outright.
    allowNegative: true,
  });
  const v = values as Record<string, string | boolean | undefined>;
  return {
    values: v,
    positionals,
    options: {
      url: String(v.url ?? process.env.NOTIFYJS_URL ?? 'ws://localhost:7741'),
      store: String(v.store ?? defaultPath()),
      // `hostname()`, not `process.env.HOSTNAME`: that is a shell variable and
      // is not exported, so every machine paired itself as `cli@localhost` and
      // `notifyjs devices` listed a column of identical names - with no way to
      // tell which entry belonged to the server you wanted to revoke.
      name: String(v.name ?? `cli@${process.env.HOSTNAME || hostname()}`),
    } satisfies CommonOptions,
  };
}

function makeClient(o: CommonOptions, autoReconnect = false): NotifyClient {
  return new NotifyClient({
    url: o.url,
    crypto: nodeCrypto,
    storage: fileStorage(o.store),
    createSocket: (url) => new WebSocket(url) as never,
    deviceName: o.name,
    platform: process.platform,
    model: 'notifyjs-cli',
    autoReconnect,
    // Silence only means something if this machine still has a network.
    isOnline: async () => hasNetwork(),
  });
}

/**
 * Whether this machine has any network at all.
 *
 * This used to resolve `localhost`, which answers a different question: the
 * loopback resolves from `/etc/hosts` on a laptop with its wifi off, so the
 * check passed always and the watchdog reported a dead hub every time this
 * machine lost its own connection. An assigned, non-internal interface is the
 * honest local answer - it cannot see an upstream outage, but it does notice
 * the unplugged cable and the radio that was switched off.
 */
function hasNetwork(): boolean {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal && entry.address) return true;
    }
  }
  return false;
}

/** Resolves once the client is authenticated, or rejects with the hub's error. */
function ready(client: NotifyClient, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out connecting to the hub')), timeoutMs);
    client.on('ready', () => {
      clearTimeout(timer);
      resolve();
    });
    client.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(err.message));
    });
    client.on('status', (status) => {
      if (status === 'unpaired') {
        clearTimeout(timer);
        reject(new Error('this machine is not paired yet - run: notifyjs pair <code>'));
        return;
      }
      // `idle` means the socket closed and nothing is going to retry: these clients
      // are built with `autoReconnect: false`, because a command either does its work
      // now or reports why not. Waiting out the full timeout for an answer that had
      // already arrived made every command against a hub that is not running take
      // fifteen seconds to say so.
      if (status === 'idle') {
        clearTimeout(timer);
        reject(new Error('could not reach the hub - is it running, and is --url right?'));
      }
    });
  });
}

async function pair(argv: string[]): Promise<void> {
  // No `--role` here: it was accepted and never read - the role belongs to the code,
  // which is minted by whoever has the authority to choose it.
  const { positionals, options } = common(argv);
  let code = positionals[0];

  if (!code) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    code = await rl.question('Pairing code: ');
    rl.close();
  }
  // Checking the checksum locally keeps a typo from spending an attempt
  // against the hub's rate limiter.
  if (!isPairingCodeValid(code)) {
    throw new Error('that pairing code is malformed - check for a typo');
  }

  const client = makeClient(options);
  const done = ready(client);
  await client.pair(code);
  await done;

  process.stdout.write(`paired as "${options.name}" with role ${client.role}\n`);
  process.stdout.write(`credentials saved to ${options.store}\n`);
  client.disconnect();
}

async function listen(argv: string[]): Promise<void> {
  const { options } = common(argv);
  const client = makeClient(options, true);

  client.on('notification', (n) => {
    printNotification(n);
    void desktopNotify(n);
    client.ack([n.id], { seq: n.seq });
  });

  // Auto-answering is the right default for an unattended machine: the point
  // of a desktop listener is that somebody hears the message.
  client.on('call', async (call) => {
    process.stdout.write(`\nincoming call: ${safeText(call.message, true)}\n`);
    client.answerCall(call.id);
    await speakCall(call);
    client.endCall(call.id);
  });

  /**
   * A machine running `notifyjs listen` is the best watchdog available: it is
   * always on, always connected, and can tell its own network apart from a
   * dead service. This is where the hub's death gets noticed most reliably.
   */
  client.on('service:missing', ({ spec, silentForMs }) => {
    const seconds = Math.round(silentForMs / 1000);
    // Everything a hub sends is filtered before it reaches this terminal, the
    // same rule the notification printer already follows.
    process.stderr.write(`\n!! ${safeText(spec.alert.title)} (silent for ${seconds}s)\n`);
    if (spec.alert.body) process.stderr.write(`   ${safeText(spec.alert.body)}\n`);
    void desktopNotify({
      id: 'service-down',
      seq: 0,
      ts: Date.now(),
      channel: 'notifyjs',
      severity: 'critical',
      title: spec.alert.title,
      body: spec.alert.body,
    });
  });

  client.on('service:back', ({ downForMs }) => {
    process.stderr.write(`   reconnected after ${Math.round(downForMs / 1000)}s\n`);
  });

  client.on('service:bye', ({ reason }) => {
    process.stderr.write(`   hub is going away on purpose: ${safeText(reason)}\n`);
  });

  client.on('status', (status) => process.stderr.write(`[${status}]\n`));
  client.on('revoked', () => {
    process.stderr.write('this device was revoked by the hub\n');
    process.exit(1);
  });

  const done = ready(client);
  await client.connect();
  await done;
  process.stdout.write(`listening on ${options.url} as ${options.name} (${client.role})\n`);

  // Disconnecting deliberately tells the hub this was not a crash, so it drops
  // the session at once instead of waiting to notice the socket went quiet.
  onShutdown(() => client.disconnect());
}

async function send(argv: string[]): Promise<void> {
  const { positionals, values, options } = common(argv, {
    severity: { type: 'string' },
    channel: { type: 'string' },
    body: { type: 'string' },
  });
  const title = positionals.join(' ');
  if (!title) throw new UsageError('usage: notifyjs send <title> [--body text] [--severity level]');
  // Before the socket, not after: a flag nobody can act on should fail without
  // a round trip, and a hub that happens to be down must not mask a typo.
  const level = severity(values.severity as string | undefined, 'info');

  const client = makeClient(options);
  const done = ready(client);
  await client.connect();
  await done;

  await client.admin('notify.send', {
    title,
    body: values.body as string | undefined,
    channel: (values.channel as string) ?? 'default',
    severity: level,
  });
  process.stdout.write('sent\n');
  client.disconnect();
}

async function placeCall(argv: string[]): Promise<void> {
  const { positionals, values, options } = common(argv, {
    severity: { type: 'string' },
    channel: { type: 'string' },
  });
  const message = positionals.join(' ');
  if (!message) throw new UsageError('usage: notifyjs call <message to speak>');
  const level = severity(values.severity as string | undefined, 'critical');

  const client = makeClient(options);
  const done = ready(client);
  await client.connect();
  await done;

  await client.admin('call.place', {
    message,
    channel: (values.channel as string) ?? 'default',
    severity: level,
  });
  process.stdout.write('call placed\n');
  client.disconnect();
}

async function devices(argv: string[]): Promise<void> {
  const { options } = common(argv);
  const client = makeClient(options);
  const done = ready(client);
  await client.connect();
  await done;

  const data = await client.admin('devices.list');
  const online = new Set(data.online);

  for (const device of data.devices) {
    const marker = online.has(device.id) ? 'online ' : 'offline';
    const seen = device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : 'never';
    process.stdout.write(
      `${marker}  ${safeText(device.name).padEnd(24)} ${safeText(device.role).padEnd(10)} ` +
        `${safeText(device.status).padEnd(8)} ${seen}\n`,
    );
  }
  client.disconnect();
}

/**
 * Copies a hub's identity out of, and back into, a directory.
 *
 * Offline on purpose. A restorable backup contains the hub's secrets, and a
 * running hub holds this document in memory - so exporting over the protocol
 * would hand secrets to whoever holds an admin credential, and importing into
 * a live hub would be written straight back over.
 */
async function backup(argv: string[]): Promise<void> {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv.shift() : 'export';
  const { values } = common(argv, {
    data: { type: 'string' },
    out: { type: 'string' },
    from: { type: 'string' },
    history: { type: 'boolean' },
    force: { type: 'boolean' },
  });
  // The same default `serve` uses, so `notifyjs export` next to a hub started
  // with no arguments finds it.
  const dir = (values.data as string) ?? '.notifyjs';

  // Both of these read and write the store's files behind a hub's back, which is
  // why both tell you to stop it first - a running hub holds the document in memory
  // and writes it on a timer, so an export can miss whatever was never flushed and
  // an import is quietly overwritten by the next flush. Neither could tell whether
  // one was running; the claim a hub leaves in its directory answers it.
  const running = hubHolding(dir);

  if (sub === 'export') {
    if (running !== undefined) {
      process.stderr.write(
        `warning: a hub is running here (pid ${running}) - it holds state in memory that\n` +
          `         this export cannot see. Stop it first for a complete backup.\n\n`,
      );
    }
    const doc = exportStore(dir, { history: values.history as boolean });
    const json = JSON.stringify(doc, null, 2);
    const out = values.out as string | undefined;
    if (!out) {
      process.stdout.write(json + '\n');
    } else {
      // 0600, and said out loud: this file is enough to impersonate the hub.
      //
      // `mode` is only honoured when the write creates the file, so an export
      // over a path that already existed - `touch backup.json` first, a file
      // from a previous run, anything checked out of a repository - kept
      // whatever permissions it had, usually 0644. The chmod is what actually
      // holds the guarantee this comment makes.
      writeFileSync(out, json + '\n', { mode: 0o600 });
      try {
        chmodSync(out, 0o600);
      } catch {
        /* a filesystem without POSIX modes, or a file we do not own */
      }
      process.stderr.write(
        `wrote ${out}\n\nThis file contains:\n` +
          backupSecrets(doc).map((s) => `  - ${s}\n`).join('') +
          `\nKeep it as you would a private key.\n`,
      );
    }
    return;
  }

  if (sub !== 'import') throw new Error(`unknown backup command: ${sub}`);

  const from = values.from as string | undefined;
  if (!from) throw new UsageError('which file? pass --from <file>');
  const doc = JSON.parse(readFileSync(from, 'utf8')) as unknown;
  if (!isBackup(doc)) throw new Error(`${from} is not a NotifyJS backup`);

  // Refused rather than warned about, because this one does not merely read an
  // incomplete picture - the running hub writes its whole in-memory document on the
  // next tick, straight over everything restored here, and the restore is gone with
  // no sign that it ever happened.
  if (running !== undefined && !values.force) {
    throw new UsageError(
      `a hub is running here (pid ${running}) and would write over this restore.\n` +
        `Stop it first, or pass --force if that pid is stale.`,
    );
  }

  const { restoredHistory, restoredAudit } = importStore(dir, doc, {
    force: values.force as boolean,
  });
  process.stdout.write(
    `restored into ${dir}\n` +
      (restoredHistory || restoredAudit
        ? `  ${restoredHistory} history entries, ${restoredAudit} audit entries\n`
        : '  store only (the backup carried no history)\n') +
      `\nStart the hub now. Devices paired against this store keep working;\n` +
      `nothing needs re-pairing.\n`,
  );
}

/**
 * Mints, lists and revokes the bearer tokens that let something publish over
 * HTTP. Over the protocol rather than by editing the store, because a running
 * hub holds the store in memory and would write straight over a second
 * process's changes.
 */
async function token(argv: string[]): Promise<void> {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv.shift() : 'list';
  const { values, positionals, options } = common(argv, {
    role: { type: 'string' },
    label: { type: 'string' },
    id: { type: 'string' },
  });
  const client = makeClient(options);
  const done = ready(client);
  await client.connect();
  await done;

  try {
    if (sub === 'create') {
      const issued = await client.admin('ingest.create', {
        role: (values.role as string) ?? 'viewer',
        label: values.label as string | undefined,
      });
      // On its own line and nowhere else: this is the only time the hub will
      // ever say it, and it is the sort of thing people pipe into a file.
      process.stdout.write(`${issued.token}\n`);
      process.stderr.write(
        `id: ${issued.id}\nrole: ${(values.role as string) ?? 'viewer'}\n` +
          `This token is shown once. The hub stores only its hash.\n`,
      );
      return;
    }

    if (sub === 'revoke') {
      // A positional, not `argv[0]`: that is whatever came first, so
      // `token revoke --url wss://hub <id>` tried to revoke "--url".
      const id = (values.id as string) ?? positionals[0];
      if (!id) throw new Error('which token? pass --id <id>');
      const { revoked } = await client.admin('ingest.revoke', { id });
      process.stdout.write(revoked ? `revoked ${id}\n` : `no live token with id ${id}\n`);
      return;
    }

    if (sub !== 'list') throw new Error(`unknown token command: ${sub}`);

    const { tokens } = await client.admin('ingest.list');
    if (tokens.length === 0) {
      process.stdout.write('no ingest tokens\n');
      return;
    }
    for (const t of tokens) {
      const state = t.revokedAt ? 'revoked' : 'live   ';
      const used = t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : 'never';
      process.stdout.write(
        `${state}  ${t.id.padEnd(18)} ${t.role.padEnd(10)} ` +
          `${safeText(t.label ?? '-').padEnd(20)} used: ${used}\n`,
      );
    }
  } finally {
    client.disconnect();
  }
}

async function code(argv: string[]): Promise<void> {
  const { values, options } = common(argv, {
    role: { type: 'string' },
    uses: { type: 'string' },
    ttl: { type: 'string' },
    qr: { type: 'boolean' },
  });
  const client = makeClient(options);
  const done = ready(client);
  await client.connect();
  await done;

  const issued = await client.admin('pair.create', {
    role: (values.role as string) ?? 'viewer',
    uses: values.uses ? count(values.uses as string, '--uses') : 1,
    ttlMs: values.ttl ? count(values.ttl as string, '--ttl') * 1000 : undefined,
  });
  if (values.qr !== false && issued.qr) process.stdout.write(`\n${issued.qr.terminal}\n\n`);
  process.stdout.write(
    `${issued.code}\nrole: ${issued.role}\nexpires: ${new Date(issued.expiresAt).toLocaleTimeString()}\n`,
  );
  client.disconnect();
}

async function cert(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { out: { type: 'string' }, host: { type: 'string', multiple: true } },
  });

  const result = await generateSelfSigned(values.out ?? '.notifyjs', values.host ?? []);
  process.stdout.write(
    `certificate: ${result.certPath}\n` +
      `private key: ${result.keyPath}\n` +
      `valid for:   ${result.hosts.join(', ')}\n\n` +
      `Start the hub with TLS:\n\n` +
      `    notifyjs serve --tls-cert ${result.certPath} --tls-key ${result.keyPath}\n\n` +
      `It is self-signed, so devices must be told to trust it.\n`,
  );
}

async function watch(argv: string[]): Promise<void> {
  const { positionals, values, options } = common(argv, {
    every: { type: 'string' },
    grace: { type: 'string' },
    severity: { type: 'string' },
    description: { type: 'string' },
  });
  const name = positionals[0];
  if (!name) throw new UsageError('usage: notifyjs watch <name> --every 24h [--grace 1h]');
  if (!values.every) throw new UsageError('--every is required, e.g. --every 24h');
  const level =
    values.severity === undefined ? undefined : severity(values.severity as string, 'critical');

  const client = makeClient(options);
  const done = ready(client);
  await client.connect();
  await done;

  const result = await client.admin('heartbeat.expect', {
    name,
    every: values.every as string,
    grace: values.grace as string | undefined,
    severity: level,
    description: values.description as string | undefined,
  });
  // What the hub armed, not what was asked for. The two can differ - a hub whose
  // sweep is slower than the interval asked for widens it - and printing the
  // request while the hub held something else is how somebody ends up waiting
  // for a page that was never going to come when they expected it.
  const armed = (result as { heartbeat?: { every: number; grace: number } }).heartbeat;
  const every = armed ? formatDuration(armed.every) : String(values.every);
  const grace = armed?.grace ? formatDuration(armed.grace) : values.grace;
  process.stdout.write(
    `watching "${name}": a check-in is expected every ${every}` +
      (grace ? ` (plus ${grace} grace)` : '') +
      `\n\nRecord one with:\n\n    notifyjs checkin ${name}\n`,
  );
  client.disconnect();
}

async function checkin(argv: string[]): Promise<void> {
  const { positionals, options } = common(argv);
  const name = positionals[0];
  if (!name) throw new UsageError('usage: notifyjs checkin <name>');

  const client = makeClient(options);
  const done = ready(client);
  await client.connect();
  await done;

  const out = await client.admin('heartbeat.checkin', { name });
  client.disconnect();

  // A silent no-op here would mean a typo quietly disables the alarm.
  if (!out.known) throw new Error(`nothing is watching "${name}" - run: notifyjs watch ${name}`);
  process.stdout.write(`checked in: ${name}\n`);
}

async function watches(argv: string[]): Promise<void> {
  const { options } = common(argv);
  const client = makeClient(options);
  const done = ready(client);
  await client.connect();
  await done;

  const out = await client.admin('heartbeats.list');

  if (out.heartbeats.length === 0) process.stdout.write('nothing is being watched\n');
  for (const beat of out.heartbeats) {
    // Through `formatDuration`, like every other duration this CLI prints. `watch`
    // confirms "a check-in is expected every 1d" and this listed the same value as
    // "every 86400s" one command later, which reads like a different setting.
    process.stdout.write(
      `${beat.missing ? 'MISSING' : 'ok     '}  ${beat.name.padEnd(24)} every ${formatDuration(
        beat.every,
      )}  last seen ${formatDuration(Math.max(0, Date.now() - beat.lastSeenAt))} ago\n`,
    );
  }
  client.disconnect();
}

/**
 * The version this build reports, and how it knows.
 *
 * `process.env.NOTIFYJS_VERSION` is stamped in at bundle time, which covers the
 * released binaries and the container. Everything installed from npm has no such
 * stamp, and the literal that used to stand in its place meant an
 * `npm i -g @osqd/notifyjs-cli` hub reported `0.1.0` for ever: `serve` asked the
 * release feed whether anything newer existed, was told yes on every start for
 * the rest of the project's life, and the dashboard's own upgrade nudge compared
 * a constant and could never fire. Read from the manifest beside the code
 * instead, which is the version that was actually published.
 */
function ownVersion(fallback: string): string {
  const stamped = process.env.NOTIFYJS_VERSION;
  if (stamped) return stamped;
  try {
    // `dist/` sits one level under the package root. `createRequire` rather than
    // a JSON import, which needs an attribute older runtimes reject outright.
    const version = createRequire(import.meta.url)('../package.json').version as unknown;
    return typeof version === 'string' && version ? version : fallback;
  } catch {
    // A checkout run straight from source, or a layout nobody expected: saying
    // the wrong version is better than refusing to start over it.
    return fallback;
  }
}

const VERSION = ownVersion('0.1.0');
const BUILT_AT = Number(process.env.NOTIFYJS_BUILT_AT ?? 0) || undefined;
const DEFAULT_REPO = 'OSQD-ts/NotifyJS';

async function update(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      check: { type: 'boolean', default: false },
      prerelease: { type: 'boolean', default: false },
      repo: { type: 'string' },
    },
  });

  const repository = values.repo ?? DEFAULT_REPO;
  process.stdout.write(`current version ${VERSION}, checking ${repository}...\n`);

  const result = await checkUpdate({
    repository,
    currentVersion: VERSION,
    includePrerelease: values.prerelease,
    currentBuiltAt: BUILT_AT,
  });

  if (!result.latest) {
    throw new Error('could not read the release feed - check the network or --repo');
  }
  if (!result.available) {
    process.stdout.write(`already up to date (latest is ${result.latest.version})\n`);
    return;
  }

  process.stdout.write(`\n  ${result.latest.tag} is available\n  ${result.latest.url}\n\n`);
  if (values.check) {
    process.stdout.write('run "notifyjs update" to install it\n');
    return;
  }

  const installed = await applyUpdate(result.latest);
  process.stdout.write(
    `installed ${installed.version} to ${installed.installedAt}\n` +
      `the previous build is kept at ${installed.backup}\n` +
      `restart any running hub to pick it up\n`,
  );
}

/**
 * `parseArgs` raises these for a flag nobody defined or a value it cannot use,
 * which is the same class of problem as the checks above and deserves the same
 * exit code rather than the one that means "the work failed".
 */
const PARSE_ARGS_CODES = new Set([
  'ERR_PARSE_ARGS_UNKNOWN_OPTION',
  'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
  'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL',
]);

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  const code = (err as { code?: unknown } | undefined)?.code;
  // An option the hub refused is the same class of problem as a flag this file
  // refused - `--web-push-subject ops@example.com` is a typo, not a hub that
  // failed - and a script wrapping `serve` reads the code to decide whether
  // retrying could ever help.
  const misuse =
    err instanceof UsageError ||
    err instanceof OptionError ||
    (typeof code === 'string' && PARSE_ARGS_CODES.has(code));
  process.exit(misuse ? 2 : 1);
});
