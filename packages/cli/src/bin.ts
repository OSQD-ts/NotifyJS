#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import WebSocket from 'ws';

import { Notifier, type Severity } from '@osqd/notifyjs';
import { NotifyClient, isPairingCodeValid, type Device } from '@osqd/notifyjs-protocol';
import { nodeCrypto } from '@osqd/notifyjs-protocol/node';

import { readFileSync } from 'node:fs';
import { fileStorage, defaultPath } from './storage.js';
import { generateSelfSigned } from './cert.js';
import { apply as applyUpdate, check as checkUpdate } from './selfupdate.js';
import { desktopNotify, printNotification, speakCall } from './desktop.js';

const HELP = `notifyjs - self-hosted notifications for your own devices

Usage
  notifyjs serve [options]        Run a standalone hub
  notifyjs listen [options]       Connect this machine as a device
  notifyjs pair <code> [options]  Pair this machine using a code
  notifyjs send <title> [options] Send a notification through a paired hub
  notifyjs call <message>         Ring the on-call devices and speak a message
  notifyjs devices                List devices known to the hub
  notifyjs code [options]         Mint a pairing code (requires an admin device)
  notifyjs cert [options]         Generate a self-signed TLS certificate
  notifyjs watch <name> [options] Expect a check-in, and alert when it stops
  notifyjs checkin <name>         Record a check-in for a watched job
  notifyjs watches                List what the hub is expecting
  notifyjs update [options]       Check for and install a newer build

Common options
  --url <ws://host:7741>   Hub to connect to (default ws://localhost:7741)
  --store <path>           Credential file (default ${defaultPath()})
  --name <name>            Name to register this device under

serve options
  --port <n>               Port to listen on (default 7741)
  --host <addr>            Bind address (default 0.0.0.0)
  --hub-name <name>        Name devices see when pairing
  --data <dir>             Hub state directory (default .notifyjs)
  --no-dashboard           Do not serve the web dashboard
  --dashboard-dir <dir>    Serve dashboard assets from this directory
  --public-url <url>       Address devices should use (default: your LAN IP)
  --tls-cert <file>        Certificate for wss:// (see: notifyjs cert)
  --tls-key <file>         Private key for wss://
  --no-qr                  Do not print a QR code for the pairing link

cert options
  --out <dir>              Where to write the certificate (default .notifyjs)
  --host <name>            Extra hostname or IP to include (repeatable)

  --admin-code             Also print an admin pairing code on start

send / call options
  --severity <level>       debug|info|success|warning|error|critical
  --channel <name>         Channel to publish on (default default)
  --body <text>            Longer body text

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
    },
    allowNegative: true,
  });

  // Both halves or neither: a certificate without its key would fail deep
  // inside the TLS server with a far less helpful message.
  const certFile = values['tls-cert'];
  const keyFile = values['tls-key'];
  if (Boolean(certFile) !== Boolean(keyFile)) {
    throw new Error('--tls-cert and --tls-key must be given together');
  }

  const hub = new Notifier({
    port: values.port ? Number(values.port) : undefined,
    host: values.host,
    name: values['hub-name'],
    storeDir: values.data,
    dashboard: values.dashboard,
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
    process.stdout.write(
      `\n  Scan the code above with the NotifyJS app, or pair manually:\n\n` +
        `      code: ${issued.code}    role: ${issued.role}\n` +
        `      hub:  ${hub.publicUrl}\n\n` +
        `  In a browser, open ${hub.dashboardUrl} and enter the code.\n` +
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

  const shutdown = async () => {
    await hub.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
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
  });
  const v = values as Record<string, string | boolean | undefined>;
  return {
    values: v,
    positionals,
    options: {
      url: String(v.url ?? process.env.NOTIFYJS_URL ?? 'ws://localhost:7741'),
      store: String(v.store ?? defaultPath()),
      name: String(v.name ?? `cli@${process.env.HOSTNAME ?? 'localhost'}`),
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
    isOnline: async () => {
      try {
        const { lookup } = await import('node:dns/promises');
        await lookup('localhost');
        return true;
      } catch {
        return false;
      }
    },
  });
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
      if (status !== 'unpaired') return;
      clearTimeout(timer);
      reject(new Error('this machine is not paired yet - run: notifyjs pair <code>'));
    });
  });
}

async function pair(argv: string[]): Promise<void> {
  const { positionals, options } = common(argv, { role: { type: 'string' } });
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
  const { options } = common(argv, { quiet: { type: 'boolean' } });
  const client = makeClient(options, true);

  client.on('notification', (n) => {
    printNotification(n);
    void desktopNotify(n);
    client.ack([n.id], { seq: n.seq });
  });

  // Auto-answering is the right default for an unattended machine: the point
  // of a desktop listener is that somebody hears the message.
  client.on('call', async (call) => {
    process.stdout.write(`\nincoming call: ${call.message}\n`);
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
    process.stderr.write(`\n!! ${spec.alert.title} (silent for ${seconds}s)\n`);
    if (spec.alert.body) process.stderr.write(`   ${spec.alert.body}\n`);
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
    process.stderr.write(`   hub is going away on purpose: ${reason}\n`);
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

  process.on('SIGINT', () => {
    client.disconnect();
    process.exit(0);
  });
}

async function send(argv: string[]): Promise<void> {
  const { positionals, values, options } = common(argv, {
    severity: { type: 'string' },
    channel: { type: 'string' },
    body: { type: 'string' },
  });
  const title = positionals.join(' ');
  if (!title) throw new Error('usage: notifyjs send <title> [--body text] [--severity level]');

  const client = makeClient(options);
  const done = ready(client);
  await client.connect();
  await done;

  await client.admin('notify.send', {
    title,
    body: values.body as string | undefined,
    channel: (values.channel as string) ?? 'default',
    severity: ((values.severity as string) ?? 'info') as Severity,
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
  if (!message) throw new Error('usage: notifyjs call <message to speak>');

  const client = makeClient(options);
  const done = ready(client);
  await client.connect();
  await done;

  await client.admin('call.place', {
    message,
    channel: (values.channel as string) ?? 'default',
    severity: ((values.severity as string) ?? 'critical') as Severity,
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

  const data = await client.admin<{ devices: Device[]; online: string[] }>('devices.list');
  const online = new Set(data.online);

  for (const device of data.devices) {
    const marker = online.has(device.id) ? 'online ' : 'offline';
    const seen = device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : 'never';
    process.stdout.write(
      `${marker}  ${device.name.padEnd(24)} ${device.role.padEnd(10)} ${device.status.padEnd(8)} ${seen}\n`,
    );
  }
  client.disconnect();
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

  const issued = await client.admin<{
    code: string;
    expiresAt: number;
    role: string;
    qr?: { terminal: string };
  }>(
    'pair.create',
    {
      role: (values.role as string) ?? 'viewer',
      uses: values.uses ? Number(values.uses) : 1,
      ttlMs: values.ttl ? Number(values.ttl) * 1000 : undefined,
    },
  );
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
  if (!name) throw new Error('usage: notifyjs watch <name> --every 24h [--grace 1h]');
  if (!values.every) throw new Error('--every is required, e.g. --every 24h');

  const client = makeClient(options);
  const done = ready(client);
  await client.connect();
  await done;

  const result = await client.admin<{ heartbeat: { every: number; grace: number } }>(
    'heartbeat.expect',
    {
      name,
      every: values.every as string,
      grace: values.grace as string | undefined,
      severity: values.severity as string | undefined,
      description: values.description as string | undefined,
    },
  );
  process.stdout.write(
    `watching "${name}": a check-in is expected every ${values.every}` +
      (values.grace ? ` (plus ${values.grace} grace)` : '') +
      `\n\nRecord one with:\n\n    notifyjs checkin ${name}\n`,
  );
  void result;
  client.disconnect();
}

async function checkin(argv: string[]): Promise<void> {
  const { positionals, options } = common(argv);
  const name = positionals[0];
  if (!name) throw new Error('usage: notifyjs checkin <name>');

  const client = makeClient(options);
  const done = ready(client);
  await client.connect();
  await done;

  const out = await client.admin<{ known: boolean }>('heartbeat.checkin', { name });
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

  const out = await client.admin<{
    heartbeats: { name: string; every: number; grace: number; lastSeenAt: number; missing: boolean }[];
  }>('heartbeats.list');

  if (out.heartbeats.length === 0) process.stdout.write('nothing is being watched\n');
  for (const beat of out.heartbeats) {
    const ago = Math.round((Date.now() - beat.lastSeenAt) / 1000);
    process.stdout.write(
      `${beat.missing ? 'MISSING' : 'ok     '}  ${beat.name.padEnd(24)} every ${Math.round(
        beat.every / 1000,
      )}s  last seen ${ago}s ago\n`,
    );
  }
  client.disconnect();
}

/** Version stamped in at bundle time; falls back for source checkouts. */
const VERSION = process.env.NOTIFYJS_VERSION ?? '0.1.0';
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

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
