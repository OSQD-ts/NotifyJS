import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Notifier, INGEST_TOKEN_PREFIX } from '../dist/index.js';

let hub;
let storeDir;
let base;
let token;

/** POSTs to the hub over loopback, which is what the insecure rule permits. */
async function post(path, body, bearer, extra = {}) {
  const headers = { 'content-type': 'application/json', ...extra };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${base}${path}`, {
    method: extra.method ? undefined : 'POST',
    ...extra,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

before(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'notifyjs-ingest-'));
  hub = new Notifier({
    port: 0,
    storeDir,
    dashboard: false,
    logger: false,
    ingest: { enabled: true },
    security: { uniformFailureMs: 5, maxFailuresBeforeBan: 1000 },
  });
  await hub.start();
  base = hub.dashboardUrl;
  token = hub.createIngestToken({ role: 'admin', label: 'ci' }).token;
});

after(async () => {
  await hub?.stop();
  rmSync(storeDir, { recursive: true, force: true });
});

test('a minted token publishes a notification', async () => {
  const seen = [];
  const onNotification = (n) => seen.push(n);
  hub.on('notification', onNotification);

  const { status, json } = await post('/api/notify', {
    title: 'Disk 91%',
    body: 'nearly full',
    severity: 'warning',
    channel: 'infra',
  }, token);

  assert.equal(status, 202);
  assert.equal(json.ok, true);
  assert.ok(json.id, 'the response carries the notification id');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].title, 'Disk 91%');
  assert.equal(seen[0].severity, 'warning');
  assert.equal(seen[0].channel, 'infra');
  hub.off('notification', onNotification);
});

test('the token is only ever returned once, and never stored in the clear', async () => {
  const minted = hub.createIngestToken({ role: 'admin', label: 'once' });
  assert.ok(minted.token.startsWith(INGEST_TOKEN_PREFIX), 'tokens are recognisable');

  const listed = hub.ingestTokens().find((t) => t.id === minted.id);
  assert.ok(listed, 'the token is listed');
  assert.equal(listed.token, undefined, 'the plaintext is not handed back');
  assert.equal(listed.hash, undefined, 'not even the hash leaves the hub');

  // The value on disk must not be the token itself.
  const raw = JSON.stringify(hub.devices());
  assert.ok(!raw.includes(minted.token));
});

test('no token, a wrong token and a revoked token are all refused', async () => {
  const anonymous = await post('/api/notify', { title: 'x' });
  assert.equal(anonymous.status, 401);

  const wrong = await post('/api/notify', { title: 'x' }, `${INGEST_TOKEN_PREFIX}nope`);
  assert.equal(wrong.status, 401);

  const doomed = hub.createIngestToken({ role: 'admin', label: 'doomed' });
  assert.equal((await post('/api/notify', { title: 'ok' }, doomed.token)).status, 202);
  assert.equal(hub.revokeIngestToken(doomed.id), true);
  const after = await post('/api/notify', { title: 'no' }, doomed.token);
  assert.equal(after.status, 401, 'a revoked token stops working immediately');
});

test('a role without notify.send cannot publish', async () => {
  // `viewer` receives and acknowledges; it has no business raising alarms.
  const viewer = hub.createIngestToken({ role: 'viewer', label: 'read-only' });
  const { status, json } = await post('/api/notify', { title: 'nope' }, viewer.token);
  assert.equal(status, 403);
  assert.match(json.message, /notify\.send/);
});

test('the body cannot smuggle fields the endpoint does not offer', async () => {
  const seen = [];
  const onNotification = (n) => seen.push(n);
  hub.on('notification', onNotification);

  await post('/api/notify', {
    title: 'ordinary',
    // All of these decide replay ordering or identity and must be the hub's
    // to set, not a caller's.
    id: 'forged-id',
    seq: 999999,
    ts: 0,
  }, token);

  const n = seen.at(-1);
  assert.notEqual(n.id, 'forged-id');
  assert.notEqual(n.seq, 999999);
  assert.ok(n.ts > 0);
  hub.off('notification', onNotification);
});

test('a title is required, and an oversized body is refused', async () => {
  assert.equal((await post('/api/notify', { body: 'no title' }, token)).status, 400);
  assert.equal((await post('/api/notify', { title: '   ' }, token)).status, 400);

  const huge = { title: 'big', body: 'x'.repeat(200 * 1024) };
  const res = await post('/api/notify', huge, token);
  assert.equal(res.status, 413, 'the limit is enforced as bytes arrive');
});

test('GET is refused, and the routes vanish when ingest is off', async () => {
  const wrongMethod = await fetch(`${base}/api/notify`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(wrongMethod.status, 405);

  const dir = mkdtempSync(join(tmpdir(), 'notifyjs-ingest-off-'));
  const closed = new Notifier({ port: 0, storeDir: dir, dashboard: false, logger: false });
  await closed.start();
  try {
    const res = await fetch(`${closed.dashboardUrl}/api/notify`, { method: 'POST', body: '{}' });
    // 404, not 403: a feature nobody turned on should not confirm it exists.
    assert.equal(res.status, 404);
  } finally {
    await closed.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a token cannot be minted into a role that does not exist', () => {
  assert.throws(() => hub.createIngestToken({ role: 'nonexistent' }), /unknown role/);
});
