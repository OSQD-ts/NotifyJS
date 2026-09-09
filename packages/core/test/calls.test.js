import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CallOrchestrator } from '../dist/calls.js';

/** A device that records what the orchestrator sent it. */
function device(id) {
  const sent = [];
  return { deviceId: id, deviceName: id, send: (m) => sent.push(m), sent };
}

const request = (id = 'c1') => ({
  id,
  from: 'test',
  message: 'hi',
  severity: 'critical',
  channel: 'db',
});

const rung = (targets, ringSeconds = 30) => ({ targets, ringSeconds, delaySeconds: 0 });

test('the device that answered dropping off releases the call', async () => {
  const orch = new CallOrchestrator(30, () => {});
  const phone = device('phone');

  const settled = orch.place(request(), [rung([phone])]);
  orch.answer('c1', 'phone');
  assert.equal((await settled).outcome, 'answered');

  // Kept on purpose, so a later `call.ended` still emits.
  assert.equal(orch.activeCount, 1);

  // Force-quit: the socket closes and `call.ended` never arrives. This is the
  // case `dropped()` exists for, and it used to be unreachable - `answer()`
  // empties `ringing`, so the answerer was skipped by the guard above it and
  // the record waited fifteen minutes for the reaper.
  orch.dropped('phone');
  assert.equal(orch.activeCount, 0, 'released the moment the socket closed');
});

test('a ringing device dropping off is treated as a declined leg', async () => {
  const orch = new CallOrchestrator(30, () => {});
  const first = device('first');
  const second = device('second');

  // Two rungs, so the ladder has somewhere to go when the first drops.
  const settled = orch.place(request('c2'), [rung([first]), rung([second])]);
  assert.ok(first.sent.some((m) => m.t === 'call'), 'the first rung rang');

  orch.dropped('first');
  assert.ok(second.sent.some((m) => m.t === 'call'), 'the ladder advanced');

  orch.answer('c2', 'second');
  const result = await settled;
  assert.equal(result.outcome, 'answered');
  assert.equal(result.deviceId, 'second');
  assert.deepEqual(result.attempted, ['first', 'second']);
});

test('a device that was never rung cannot steer the call', async () => {
  const orch = new CallOrchestrator(30, () => {});
  const rung1 = device('rung');
  const stranger = device('stranger');

  const settled = orch.place(request('c3'), [rung([rung1])]);

  // Knowing a call id must not be enough to answer, decline or end it.
  orch.answer('c3', 'stranger');
  orch.decline('c3', 'stranger');
  orch.ended('c3', 'stranger');
  assert.equal(orch.activeCount, 1, 'still ringing the device it was meant for');
  assert.equal(stranger.sent.length, 0);

  orch.answer('c3', 'rung');
  assert.equal((await settled).deviceId, 'rung');
});

test('an unreachable ladder fails rather than hanging', async () => {
  const orch = new CallOrchestrator(30, () => {});
  const result = await orch.place(request('c4'), [rung([]), rung([])]);
  assert.equal(result.outcome, 'failed');
  assert.deepEqual(result.attempted, []);
  assert.equal(orch.activeCount, 0);
});

test('cancelling tells every ringing device why', async () => {
  const orch = new CallOrchestrator(30, () => {});
  const a = device('a');
  const b = device('b');

  const settled = orch.place(request('c5'), [rung([a, b])]);
  assert.equal(orch.cancel('c5'), true);

  const result = await settled;
  assert.equal(result.outcome, 'cancelled');
  for (const d of [a, b]) {
    assert.ok(
      d.sent.some((m) => m.t === 'call.cancel' && m.reason === 'cancelled'),
      `${d.deviceId} was told`,
    );
  }
  assert.equal(orch.cancel('c5'), false, 'a call that is gone cannot be cancelled twice');
});

test('everyone declining reports declined, not missed', async () => {
  const orch = new CallOrchestrator(30, () => {});
  const a = device('a');
  const b = device('b');

  const settled = orch.place(request('c6'), [rung([a]), rung([b])]);
  orch.decline('c6', 'a');
  orch.decline('c6', 'b');

  const result = await settled;
  // Somebody saw the page and said no, which is not the same as nobody
  // looking at their phone.
  assert.equal(result.outcome, 'declined');
  assert.deepEqual(result.attempted, ['a', 'b']);
});
