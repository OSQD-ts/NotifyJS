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

test('a phone that vanished mid-ring is a missed call, not a declined one', async () => {
  // `dropped()` routed a lost socket through `decline()`, so a phone that lost
  // Wi-Fi while ringing put the whole call's outcome at `declined` - telling the
  // caller a human had refused, and leaving the `outcome === 'missed'` fallback
  // every embedder is told to write unrun.
  const orch = new CallOrchestrator(30, () => {});
  const phone = device('phone');

  const settled = orch.place(request('c-vanish'), [rung([phone], 1)]);
  assert.ok(phone.sent.some((m) => m.t === 'call'), 'it rang');

  orch.dropped('phone');

  const result = await settled;
  assert.equal(result.outcome, 'missed', 'nobody saw the page');
  assert.deepEqual(result.attempted, ['phone']);
});

test('an explicit decline is still reported as declined', async () => {
  const orch = new CallOrchestrator(30, () => {});
  const phone = device('phone');

  const settled = orch.place(request('c-decline'), [rung([phone], 1)]);
  orch.decline('c-decline', 'phone');

  assert.equal((await settled).outcome, 'declined');
});

test('a repeated ladder does not report a decline from an earlier pass', async () => {
  // `declined` survived the repeat, so a phone that said no on the first pass
  // and was simply not answered on the last one made the call report `declined`
  // - a final pass nobody touched, indistinguishable from a refusal.
  const orch = new CallOrchestrator(30, () => {});
  const phone = device('phone');

  // Ring for a moment, twice over: declined on the first pass, ignored on the
  // second.
  const settled = orch.place(request('c-repeat'), [rung([phone], 0.05)], 1);
  orch.decline('c-repeat', 'phone');

  // Every timer in the orchestrator is unref'd, so something has to hold the
  // loop open while the second pass rings itself out.
  const result = await Promise.race([
    settled,
    new Promise((resolve) => setTimeout(() => resolve({ outcome: 'never settled' }), 1000)),
  ]);
  assert.equal(result.outcome, 'missed', 'the pass nobody answered decides it');
});

test('a stranger cannot walk a call that has not started ringing yet', async () => {
  // The guard this covers - `if (!call.ringing.has(deviceId)) return` - is not
  // load-bearing while a rung is already ringing, because the rung advances on its
  // own once everyone on it has answered. It matters during a `delaySeconds`
  // window, when `ringing` is empty: without it, any device that has merely
  // learned the call id walks the ladder forward and settles the page as missed.
  const orch = new CallOrchestrator(30, () => {});
  const phone = device('phone');
  const stranger = device('stranger');

  const settled = orch.place(request('c-delay'), [
    { targets: [phone], ringSeconds: 1, delaySeconds: 1 },
  ]);
  assert.equal(phone.sent.length, 0, 'the rung has not started');

  orch.decline('c-delay', 'stranger');
  orch.answer('c-delay', 'stranger');
  orch.ended('c-delay', 'stranger');
  assert.equal(orch.activeCount, 1, 'the call is untouched');

  // It then rings the device it was meant for, and that device can answer.
  await new Promise((r) => setTimeout(r, 1100));
  assert.ok(phone.sent.some((m) => m.t === 'call'), 'the rung rang after its delay');
  orch.answer('c-delay', 'phone');
  assert.equal((await settled).outcome, 'answered');
});

test('a device that vanishes mid-ring says so in the events', async () => {
  // The outcome is covered above; this is the audit trail. Routing a lost socket
  // through `decline()` wrote a `call.declined` row, which was wrong, and emitting
  // nothing left an operator with no answer to "why did this escalate?".
  const events = [];
  const orch = new CallOrchestrator(30, (e) => events.push(e));
  const phone = device('phone');

  const settled = orch.place(request('c-vanish-event'), [rung([phone], 1)]);
  orch.dropped('phone');
  await settled;

  assert.deepEqual(
    events.map((e) => e.type),
    ['ringing', 'vanished', 'missed'],
    'the disappearance is named, and is not a decline',
  );
});

test('a call with nobody to ring says so, rather than only returning', async () => {
  // The outcome existed solely in the return value: the audit log could not tell a
  // call that failed from one still ringing, and an application driving escalation
  // off the event never heard about it at all.
  const events = [];
  const orch = new CallOrchestrator(30, (e) => events.push(e));

  const result = await orch.place(request('c-nobody'), [rung([])]);
  assert.equal(result.outcome, 'failed');
  assert.deepEqual(events, [{ type: 'failed', callId: 'c-nobody' }]);
});
