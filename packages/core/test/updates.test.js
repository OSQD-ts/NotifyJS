import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkForUpdate, compareVersions, isNewer, findAsset } from '@notifyjs/protocol';
import { apply, assetPattern } from '@notifyjs/cli';

test('versions compare numerically, not alphabetically', () => {
  assert.equal(compareVersions('0.2.0', '0.1.0'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('v0.2.0', '0.2.0'), 0, 'a leading v is ignored');

  // The case string comparison gets wrong, and the one a project hits exactly
  // when it stops being new.
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1, '0.10.0 is newer than 0.9.0');
  assert.equal(isNewer('0.10.0', '0.9.0'), true);
  assert.equal(isNewer('0.9.0', '0.10.0'), false);

  assert.equal(compareVersions('1.2', '1.2.0'), 0, 'missing parts count as zero');
  assert.equal(isNewer('0.2.0-rc1', '0.2.0'), false, 'a prerelease is not newer than its release');
});

/** Stands in for the GitHub releases API. */
function releaseFeed(releases) {
  return async () => ({
    ok: true,
    json: async () => releases,
  });
}

const release = (tag, extra = {}) => ({
  tag_name: tag,
  html_url: `https://example.test/${tag}`,
  body: 'notes',
  draft: false,
  prerelease: false,
  published_at: '2026-01-01T00:00:00Z',
  assets: [],
  ...extra,
});

test('an update is offered only when it is actually newer', async () => {
  const feed = releaseFeed([release('v0.3.0'), release('v0.2.0')]);

  const behind = await checkForUpdate({
    repository: 'x/y', currentVersion: '0.2.0', fetchImpl: feed,
  });
  assert.equal(behind.available, true);
  assert.equal(behind.latest.version, '0.3.0');

  const current = await checkForUpdate({
    repository: 'x/y', currentVersion: '0.3.0', fetchImpl: feed,
  });
  assert.equal(current.available, false, 'the newest version is not an update');

  const ahead = await checkForUpdate({
    repository: 'x/y', currentVersion: '0.4.0', fetchImpl: feed,
  });
  assert.equal(ahead.available, false, 'a local build ahead of the feed is not downgraded');
});

test('prereleases are opt-in', async () => {
  const feed = releaseFeed([release('latest', { prerelease: true }), release('v0.2.0')]);

  const stable = await checkForUpdate({
    repository: 'x/y', currentVersion: '0.1.0', fetchImpl: feed,
  });
  assert.equal(stable.latest.tag, 'v0.2.0', 'the rolling build is ignored by default');

  const rolling = await checkForUpdate({
    repository: 'x/y', currentVersion: '0.1.0', includePrerelease: true, fetchImpl: feed,
  });
  assert.ok(rolling.available);
});

test('drafts are never offered', async () => {
  const feed = releaseFeed([release('v9.9.9', { draft: true }), release('v0.2.0')]);
  const result = await checkForUpdate({ repository: 'x/y', currentVersion: '0.1.0', fetchImpl: feed });
  assert.equal(result.latest.tag, 'v0.2.0');
});

test('an unreachable feed is not an error', async () => {
  const result = await checkForUpdate({
    repository: 'x/y',
    currentVersion: '0.1.0',
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  assert.equal(result.available, false, 'the app keeps working on the version it has');
  assert.equal(result.current, '0.1.0');
});

test('the platform asset is matched, and a missing one is not guessed at', () => {
  const info = {
    version: '0.2.0', tag: 'v0.2.0', notes: '', url: '', prerelease: false, publishedAt: 0,
    assets: [
      { name: 'notifyjs-linux-x64.tar.gz', url: 'u1', size: 1 },
      { name: 'notifyjs-windows-x64.zip', url: 'u2', size: 1 },
    ],
  };
  assert.equal(findAsset(info, /notifyjs-linux-x64\.tar\.gz$/).url, 'u1');
  assert.equal(findAsset(info, /notifyjs-macos-arm64/), undefined);
  assert.match(assetPattern().source, /notifyjs-/);
});

/* ------------------------------------------------------------------ */
/* Installing                                                          */
/* ------------------------------------------------------------------ */

/** Serves a real archive and checksum file, as a release would. */
async function releaseServer(binaryContents, { corrupt = false, omitSums = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'notifyjs-rel-'));
  mkdirSync(join(dir, 'notifyjs'), { recursive: true });
  writeFileSync(join(dir, 'notifyjs', 'notifyjs'), binaryContents);
  execFileSync('tar', ['czf', join(dir, 'pkg.tar.gz'), '-C', dir, 'notifyjs']);

  const archive = readFileSync(join(dir, 'pkg.tar.gz'));
  const digest = createHash('sha256').update(archive).digest('hex');
  const name = `notifyjs-${process.platform === 'darwin' ? 'macos' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}.tar.gz`;
  const sums = `${corrupt ? '0'.repeat(64) : digest}  ${name}\n`;

  const server = createServer((req, res) => {
    if (req.url === '/archive') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(archive);
    } else if (req.url === '/sums' && !omitSums) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(sums);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const info = {
    version: '9.9.9', tag: 'v9.9.9', notes: '', url: '', prerelease: false, publishedAt: 0,
    assets: [
      { name, url: `http://127.0.0.1:${port}/archive`, size: archive.length },
      ...(omitSums ? [] : [{ name: 'SHA256SUMS.txt', url: `http://127.0.0.1:${port}/sums`, size: sums.length }]),
    ],
  };
  return { info, close: () => { server.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function fakeInstalled(contents = '#!/bin/sh\necho old\n') {
  const dir = mkdtempSync(join(tmpdir(), 'notifyjs-inst-'));
  const target = join(dir, 'notifyjs');
  writeFileSync(target, contents);
  chmodSync(target, 0o755);
  return { dir, target };
}

test('a verified release replaces the binary and keeps the old one', async () => {
  const { info, close } = await releaseServer('#!/bin/sh\necho new\n');
  const { dir, target } = fakeInstalled();

  const result = await apply(info, { targetPath: target });

  assert.equal(result.version, '9.9.9');
  assert.match(readFileSync(target, 'utf8'), /echo new/, 'the new binary is in place');
  assert.match(readFileSync(result.backup, 'utf8'), /echo old/, 'the previous build is recoverable');

  close();
  rmSync(dir, { recursive: true, force: true });
});

test('a tampered download is refused and the binary is left alone', async () => {
  const { info, close } = await releaseServer('#!/bin/sh\necho evil\n', { corrupt: true });
  const { dir, target } = fakeInstalled();

  // This is the property that separates an updater from a remote code
  // execution primitive: anything that can answer the download must still not
  // be able to replace the binary.
  await assert.rejects(() => apply(info, { targetPath: target }), /checksum mismatch/);
  assert.match(readFileSync(target, 'utf8'), /echo old/, 'the running binary is untouched');

  close();
  rmSync(dir, { recursive: true, force: true });
});

test('a release without checksums is refused outright', async () => {
  const { info, close } = await releaseServer('#!/bin/sh\necho new\n', { omitSums: true });
  const { dir, target } = fakeInstalled();

  await assert.rejects(() => apply(info, { targetPath: target }), /no checksums/);
  assert.match(readFileSync(target, 'utf8'), /echo old/);

  close();
  rmSync(dir, { recursive: true, force: true });
});

test('a release with no build for this platform is refused', async () => {
  const info = {
    version: '9.9.9', tag: 'v9.9.9', notes: '', url: '', prerelease: false, publishedAt: 0,
    assets: [{ name: 'notifyjs-solaris-sparc.tar.gz', url: 'u', size: 1 }],
  };
  const { dir, target } = fakeInstalled();
  await assert.rejects(() => apply(info, { targetPath: target }), /no build for/);
  rmSync(dir, { recursive: true, force: true });
});

test('a source checkout run under node refuses to overwrite node itself', async () => {
  const { info, close } = await releaseServer('#!/bin/sh\necho new\n');
  await assert.rejects(() => apply(info, { targetPath: process.execPath }), /packaged binary/);
  close();
});
