import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FEED_LIMIT,
  addToFeed,
  callAnswered,
  markResolved,
  promptIsFresh,
  shouldWatch,
} from '../dist-test/state.js';

/** A feed entry in the shape the hub delivers one. */
function entry(id, sourceId = 'hub-a', extra = {}) {
  return {
    sourceId,
    sourceLabel: sourceId,
    notification: { id, title: `alert ${id}`, severity: 'warning', channel: 'db', seq: 1, ts: 1 },
    ...extra,
  };
}

/* ------------------------------- the feed ------------------------------ */

test('an alert is added once, newest first', () => {
  const feed = addToFeed(addToFeed([], entry('a')), entry('b'));
  assert.deepEqual(
    feed.map((e) => e.notification.id),
    ['b', 'a'],
  );
});

test('a replayed alert is not added twice', () => {
  const once = addToFeed([], entry('a'));
  const twice = addToFeed(once, entry('a'));
  assert.equal(twice.length, 1);
  // The same array back, so a subscriber is not re-rendered over nothing.
  assert.equal(twice, once, 'an unchanged feed keeps its identity');
});

test('the same id from two hubs is two alerts, not one', () => {
  // Ids are unique per hub, so a phone watching several can hold the same one
  // twice - and collapsing them would hide a real alert.
  const feed = addToFeed(addToFeed([], entry('same', 'hub-a')), entry('same', 'hub-b'));
  assert.equal(feed.length, 2);
});

test('the feed is bounded', () => {
  let feed = [];
  for (let i = 0; i < FEED_LIMIT + 50; i += 1) feed = addToFeed(feed, entry(`n${i}`));
  assert.equal(feed.length, FEED_LIMIT);
  // The cap drops the oldest, never the newest.
  assert.equal(feed[0].notification.id, `n${FEED_LIMIT + 49}`);
});

/* ----------------------------- resolution ------------------------------ */

test('resolving stamps only the matching, unresolved alerts', () => {
  const feed = [entry('a'), entry('b'), entry('c', 'hub-b')];
  const resolved = markResolved(feed, 'hub-a', ['a', 'c'], 1000);

  assert.equal(resolved[0].resolvedAt, 1000, 'a matches');
  assert.equal(resolved[1].resolvedAt, undefined, 'b was not named');
  assert.equal(resolved[2].resolvedAt, undefined, 'c belongs to another hub');
});

test('a repeated resolution does not move the timestamp', () => {
  const first = markResolved([entry('a')], 'hub-a', ['a'], 1000);
  const second = markResolved(first, 'hub-a', ['a'], 9999);
  // Otherwise "resolved 20 minutes ago" jumps back to "just now" on every
  // replay of the same resolution.
  assert.equal(second[0].resolvedAt, 1000);
});

/* ------------------------------ watching ------------------------------- */

test('watching needs both the setting and something to watch', () => {
  const on = { keepAlive: true };
  const off = { keepAlive: false };
  const enabled = [{ enabled: true }];
  const disabled = [{ enabled: false }];

  assert.equal(shouldWatch(on, enabled), true);
  assert.equal(shouldWatch(off, enabled), false, 'the user turned it off');
  assert.equal(shouldWatch(on, disabled), false, 'nothing to keep a socket to');
  assert.equal(shouldWatch(on, []), false, 'no sources at all');
});

/* -------------------------------- calls -------------------------------- */

test('a call counts as answered only when the ids line up', () => {
  const call = { sourceId: 'hub-a', sourceLabel: 'a', call: { id: 'c1' } };

  assert.equal(callAnswered(call, 'c1'), true);
  assert.equal(callAnswered(call, 'c2'), false, 'a different call was answered');
  assert.equal(callAnswered(call, undefined), false, 'nothing answered yet');
  // The answer can arrive before the call does - tapping Answer on a lock
  // screen is often what starts the app - and that is not an answered call
  // until the call itself turns up.
  assert.equal(callAnswered(undefined, 'c1'), false);
});

/* ------------------------------- prompts ------------------------------- */

test('a prompt is quiet inside its cooldown and asks again after it', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = 100 * day;

  assert.equal(promptIsFresh(String(now - day), 14 * day, now), true, 'asked yesterday');
  assert.equal(promptIsFresh(String(now - 20 * day), 14 * day, now), false, 'asked long ago');
});

test('an unreadable prompt record asks once more rather than never', () => {
  const now = Date.now();
  // '1' is what the one-time version of this prompt wrote before it grew a
  // cooldown, so an upgraded install must not read as "asked just now".
  assert.equal(promptIsFresh('1', 1000, now), false);
  assert.equal(promptIsFresh(null, 1000, now), false, 'never asked');
  assert.equal(promptIsFresh('nonsense', 1000, now), false);
  assert.equal(promptIsFresh('0', 1000, now), false);
});
