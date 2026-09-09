import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Watchdog } from '../dist/watchdog.js';

/** A watchdog that records what it would have paged somebody about. */
function watching() {
  const missed = [];
  const recovered = [];
  const dog = new Watchdog(
    (e) => missed.push(e),
    (b) => recovered.push(b),
    5_000,
  );
  return { dog, missed, recovered };
}

const beat = (over) => ({
  name: 'nightly-backup',
  every: 60_000,
  grace: 0,
  severity: 'critical',
  channel: 'heartbeat',
  repeat: false,
  lastSeenAt: Date.now(),
  missing: false,
  createdAt: Date.now(),
  ...over,
});

test('a well-formed heartbeat is restored', () => {
  const { dog } = watching();
  dog.restore([beat()]);
  assert.equal(dog.list().length, 1);
  assert.equal(dog.get('nightly-backup').every, 60_000);
  dog.stop();
});

test('a heartbeat with an unusable interval is dropped, not watched badly', () => {
  const { dog } = watching();
  // `NaN` makes the overdue comparison false, so the sweep falls straight
  // through to raising the alarm - a corrupt store would page somebody
  // immediately, and keep doing it. The store is a JSON file this project
  // already assumes can be truncated or hand-edited.
  dog.restore([
    beat({ name: 'nan', every: Number.NaN }),
    beat({ name: 'zero', every: 0 }),
    beat({ name: 'negative', every: -1 }),
    beat({ name: 'string', every: '5m' }),
    beat({ name: 'missing-name', name: '' }),
  ]);
  assert.deepEqual(dog.list(), [], 'nothing unusable is watched');
  dog.stop();
});

test('a corrupt store does not page anybody when the sweep runs', async () => {
  const missed = [];
  // A 20ms tick so the sweep actually happens, rather than asserting against a
  // watchdog that never got round to looking.
  const dog = new Watchdog((e) => missed.push(e), () => {}, 20);
  dog.restore([beat({ name: 'broken', every: Number.NaN, lastSeenAt: 0 })]);

  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(missed, [], 'silence, because the heartbeat was never taken on');

  // And prove the rig would have caught a real miss, so the silence above
  // means something.
  dog.expect('real', { every: '1ms' });
  dog.get('real').lastSeenAt = Date.now() - 60_000;
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(missed.length >= 1, 'a genuine overdue check-in still pages');
  dog.stop();
});

test('a nonsensical last check-in counts as just seen', () => {
  const { dog } = watching();
  const before = Date.now();
  dog.restore([beat({ lastSeenAt: Number.NaN })]);

  // Otherwise the job reads as overdue by decades on the first sweep after a
  // restart, which is the same false page by a different route.
  const restored = dog.get('nightly-backup');
  assert.ok(restored.lastSeenAt >= before, 'treated as current');
  dog.stop();
});

test('a negative grace is clamped rather than trusted', () => {
  const { dog } = watching();
  dog.restore([beat({ grace: -5000 })]);
  assert.equal(dog.get('nightly-backup').grace, 0);
  dog.stop();
});
