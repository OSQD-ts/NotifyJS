import type { CallRequest, CallResult, ServerMessage } from '@osqd/notifyjs-protocol';
import { PROTOCOL_VERSION } from '@osqd/notifyjs-protocol';

/** The slice of a session the orchestrator needs; keeps calls unit-testable. */
export interface CallTarget {
  deviceId: string;
  deviceName: string;
  send(msg: ServerMessage): void;
}

/**
 * One rung of the ladder, with its targets already resolved to live sessions.
 */
export interface CallStep {
  targets: CallTarget[];
  ringSeconds: number;
  delaySeconds: number;
}

interface ActiveCall {
  request: CallRequest;
  steps: CallStep[];
  /** Index of the rung currently ringing. */
  cursor: number;
  /** Times the whole ladder has been run. */
  pass: number;
  repeat: number;
  attempted: string[];
  declined: Set<string>;
  ringing: Set<string>;
  timer: NodeJS.Timeout | undefined;
  /** Drops an answered call whose `call.ended` never arrives. See `answer()`. */
  reaper: NodeJS.Timeout | undefined;
  answeredBy?: CallTarget;
  answeredAt?: number;
  settle: (result: CallResult) => void;
  settled: boolean;
}

export type CallEvent =
  | { type: 'ringing'; callId: string; deviceId: string; deviceName: string }
  | { type: 'answered'; callId: string; deviceId: string; deviceName: string }
  | { type: 'declined'; callId: string; deviceId: string }
  | { type: 'ended'; callId: string; deviceId: string }
  | { type: 'missed'; callId: string };

/**
 * Drives a call from "somebody should hear about this" to a definite outcome.
 *
 * Two modes: escalation rings devices one at a time so a call reaches a person
 * rather than lighting up every screen at once, and broadcast rings everyone
 * and lets the first answer win. Either way the caller gets one awaited
 * `CallResult`, so the developer writes `if ((await notify.call(...)).outcome
 * === 'missed')` instead of wiring up callbacks.
 */
/**
 * How long an answered call is kept waiting for its `call.ended`. Generous
 * enough for a long message repeated five times, short enough that a device
 * that never reports back does not pin the record forever.
 */
const ANSWERED_CALL_TTL_MS = 15 * 60_000;

export class CallOrchestrator {
  private active = new Map<string, ActiveCall>();

  constructor(
    private readonly defaultRingSeconds: number,
    private readonly emit: (e: CallEvent) => void,
  ) {}

  get activeCount(): number {
    return this.active.size;
  }

  /**
   * Runs a call down a ladder of steps.
   *
   * Both original modes are just shapes of ladder: escalation is one device
   * per rung, broadcast is every device on a single rung. Expressing them the
   * same way is what lets a named policy slot in without a second code path.
   */
  place(request: CallRequest, steps: CallStep[], repeat = 0): Promise<CallResult> {
    const reachable = steps.some((step) => step.targets.length > 0);
    if (!reachable) {
      return Promise.resolve({ callId: request.id, outcome: 'failed', attempted: [] });
    }

    return new Promise<CallResult>((resolve) => {
      const call: ActiveCall = {
        request,
        steps,
        cursor: 0,
        pass: 0,
        repeat,
        attempted: [],
        declined: new Set(),
        ringing: new Set(),
        timer: undefined,
        reaper: undefined,
        settle: resolve,
        settled: false,
      };
      this.active.set(request.id, call);
      this.runStep(call);
    });
  }

  private runStep(call: ActiveCall): void {
    const step = call.steps[call.cursor];
    if (!step) {
      // Ladder exhausted. Repeat it if the policy says to, otherwise report.
      if (call.pass < call.repeat) {
        call.pass += 1;
        call.cursor = 0;
        call.ringing.clear();
        this.runStep(call);
        return;
      }
      this.exhausted(call);
      return;
    }

    if (step.targets.length === 0) {
      call.cursor += 1;
      this.runStep(call);
      return;
    }

    const start = () => {
      for (const target of step.targets) {
        if (!call.attempted.includes(target.deviceId)) call.attempted.push(target.deviceId);
        call.ringing.add(target.deviceId);
        target.send({ v: PROTOCOL_VERSION, t: 'call', c: call.request });
        this.emit({
          type: 'ringing',
          callId: call.request.id,
          deviceId: target.deviceId,
          deviceName: target.deviceName,
        });
      }

      call.timer = setTimeout(() => this.advance(call, step), step.ringSeconds * 1000);
      call.timer.unref?.();
    };

    if (step.delaySeconds > 0) {
      call.timer = setTimeout(start, step.delaySeconds * 1000);
      call.timer.unref?.();
    } else {
      start();
    }
  }

  /** This rung ran out of time; silence it and move to the next. */
  private advance(call: ActiveCall, step: CallStep): void {
    for (const target of step.targets) {
      if (!call.ringing.has(target.deviceId)) continue;
      // Stop this rung ringing before the next starts, or the user ends up
      // with two phones going for one incident.
      call.ringing.delete(target.deviceId);
      target.send({
        v: PROTOCOL_VERSION,
        t: 'call.cancel',
        callId: call.request.id,
        reason: 'missed',
      });
    }
    call.cursor += 1;
    this.runStep(call);
  }

  answer(callId: string, deviceId: string): void {
    const call = this.active.get(callId);
    if (!call || call.answeredBy) return;
    const target = this.findTarget(call, deviceId);
    if (!target || !call.ringing.has(deviceId)) return;

    this.clearTimer(call);
    call.answeredBy = target;
    call.answeredAt = Date.now();
    call.ringing.delete(deviceId);

    // Everyone else stops ringing immediately; `taken` lets their UI say why.
    for (const other of this.allTargets(call)) {
      if (other.deviceId === deviceId || !call.ringing.has(other.deviceId)) continue;
      other.send({ v: PROTOCOL_VERSION, t: 'call.cancel', callId, reason: 'taken' });
    }
    call.ringing.clear();

    this.emit({ type: 'answered', callId, deviceId, deviceName: target.deviceName });
    this.settle(call, {
      callId,
      outcome: 'answered',
      deviceId,
      deviceName: target.deviceName,
      answeredAt: call.answeredAt,
      attempted: call.attempted,
    });

    // An answered call is kept so a later `call.ended` still emits - but that
    // frame is not guaranteed. A device whose speech engine hung, or that was
    // force-quit without closing its socket, never sends it, and the record
    // would sit here for the life of the process, counted by `activeCount` and
    // reported as a call still ringing. The promise has already settled, so
    // expiring the record costs the caller nothing.
    call.reaper = setTimeout(() => this.active.delete(callId), ANSWERED_CALL_TTL_MS);
    call.reaper.unref?.();
  }

  /**
   * A device saying "not me".
   *
   * Only a device this rung is actually ringing may decline it - the same rule
   * `answer()` and `ended()` enforce, and for the same reason. A decline that
   * empties the rung advances the ladder immediately, so without the check any
   * device that merely learned a call id could clear the timer mid-delay and
   * walk the page down to "missed" without a single phone ever ringing.
   */
  decline(callId: string, deviceId: string): void {
    const call = this.active.get(callId);
    if (!call || call.answeredBy) return;
    if (!call.ringing.has(deviceId)) return;
    call.declined.add(deviceId);
    call.ringing.delete(deviceId);
    this.emit({ type: 'declined', callId, deviceId });

    // A decline is an explicit "not me", so move on as soon as everyone on
    // this rung has said so, rather than waiting out the ring timeout.
    if (call.ringing.size > 0) return;

    this.clearTimer(call);
    call.cursor += 1;
    this.runStep(call);
  }

  private findTarget(call: ActiveCall, deviceId: string): CallTarget | undefined {
    return this.allTargets(call).find((t) => t.deviceId === deviceId);
  }

  private allTargets(call: ActiveCall): CallTarget[] {
    return call.steps.flatMap((step) => step.targets);
  }

  /**
   * The device finished speaking the message and hung up.
   *
   * Only the device that answered may end a call. Without that check any
   * device that was merely rung - and so learned the call id - could retire a
   * call that is still ringing somebody else: the orchestrator would forget
   * it, the real answer would be ignored, and the caller would be told the
   * page went unanswered.
   */
  ended(callId: string, deviceId: string): void {
    const call = this.active.get(callId);
    if (!call) return;
    if (call.answeredBy?.deviceId !== deviceId) return;
    this.clearTimer(call);
    this.emit({ type: 'ended', callId, deviceId });
    // Answered calls have already settled; this only releases the record.
    this.settle(call, {
      callId,
      outcome: 'answered',
      deviceId,
      deviceName: call.answeredBy.deviceName,
      answeredAt: call.answeredAt,
      endedAt: Date.now(),
      attempted: call.attempted,
    });
    this.active.delete(callId);
  }

  /** A ringing device dropped off the network; treat it as an unanswered leg. */
  dropped(deviceId: string): void {
    for (const call of [...this.active.values()]) {
      if (!call.ringing.has(deviceId)) continue;
      if (call.answeredBy?.deviceId === deviceId) {
        this.clearTimer(call);
        this.active.delete(call.request.id);
        continue;
      }
      this.decline(call.request.id, deviceId);
    }
  }

  cancel(callId: string, reason: 'cancelled' = 'cancelled'): boolean {
    const call = this.active.get(callId);
    if (!call) return false;
    this.clearTimer(call);
    for (const deviceId of call.ringing) {
      this.findTarget(call, deviceId)?.send({
        v: PROTOCOL_VERSION,
        t: 'call.cancel',
        callId,
        reason,
      });
    }
    call.ringing.clear();
    this.settle(call, { callId, outcome: reason, attempted: call.attempted });
    this.active.delete(callId);
    return true;
  }

  cancelAll(): void {
    for (const id of [...this.active.keys()]) this.cancel(id);
  }

  /**
   * Every device has now had its turn. "Declined" and "missed" are reported
   * separately because they mean different things to the caller: somebody saw
   * the page and said no, versus nobody looked at their phone at all.
   */
  private exhausted(call: ActiveCall): void {
    const allDeclined =
      call.attempted.length > 0 && call.attempted.every((id) => call.declined.has(id));
    if (!allDeclined) {
      this.miss(call);
      return;
    }
    this.clearTimer(call);
    this.emit({ type: 'declined', callId: call.request.id, deviceId: '' });
    this.settle(call, {
      callId: call.request.id,
      outcome: 'declined',
      attempted: call.attempted,
    });
    this.active.delete(call.request.id);
  }

  private miss(call: ActiveCall): void {
    this.clearTimer(call);
    for (const deviceId of call.ringing) {
      this.findTarget(call, deviceId)?.send({
        v: PROTOCOL_VERSION,
        t: 'call.cancel',
        callId: call.request.id,
        reason: 'missed',
      });
    }
    call.ringing.clear();
    this.emit({ type: 'missed', callId: call.request.id });
    this.settle(call, {
      callId: call.request.id,
      outcome: 'missed',
      attempted: call.attempted,
    });
    this.active.delete(call.request.id);
  }

  /**
   * Resolves the awaited promise exactly once. An answered call stays in the
   * map afterwards so a later `call.ended` still emits, which is why settling
   * and removal are separate steps.
   */
  private settle(call: ActiveCall, result: CallResult): void {
    if (call.settled) return;
    call.settled = true;
    call.settle(result);
  }

  private clearTimer(call: ActiveCall): void {
    if (call.timer) clearTimeout(call.timer);
    call.timer = undefined;
    if (call.reaper) clearTimeout(call.reaper);
    call.reaper = undefined;
  }
}
