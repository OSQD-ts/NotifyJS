import type { CallRequest } from '@osqd/notifyjs-protocol';

/**
 * Ringing and speech for the browser client.
 *
 * The ringtone is synthesised with WebAudio rather than shipped as an asset:
 * it keeps the dashboard a single self-hosted page with no binary payload, and
 * it means the hub's strict `default-src 'self'` CSP needs no exception.
 */
export class Ringer {
  private ctx: AudioContext | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;

  /**
   * Browsers refuse to start audio without a prior user gesture. Calling this
   * from a click (say, "Enable alerts") unlocks the context for later rings.
   */
  async unlock(): Promise<void> {
    this.ctx ??= new AudioContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  start(ringSeconds?: number): void {
    // Already ringing: the tone carries on, but this call's own deadline
    // replaces the one it would have inherited. A second call arriving late in
    // the first one's window was cut off when that window expired - the first
    // call's `ringSeconds`, not its own - leaving a call on screen, unanswered
    // and silent, for the rest of the hub's ring. The Android ringer has always
    // re-posted the deadline for the call now ringing.
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = setTimeout(() => this.stop(), maxRingMs(ringSeconds));
    if (this.timer) return;
    const beep = () => {
      if (!this.ctx || this.ctx.state !== 'running') return;
      // Two short tones, the cadence of a desk phone.
      this.tone(this.ctx.currentTime, 0.4);
      this.tone(this.ctx.currentTime + 0.5, 0.4);
    };
    // Tried here too, not only from a gesture: a page somebody has already
    // clicked on may resume without one, and a call must not wait for a click
    // that nothing prompts.
    if (!this.ctx && typeof AudioContext !== 'undefined') this.ctx = new AudioContext();
    if (this.ctx?.state === 'suspended') void this.ctx.resume().then(beep, () => {});
    beep();
    this.timer = setInterval(beep, 2000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = undefined;
  }

  private tone(at: number, duration: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    // Ramp the envelope rather than gating hard, which would click audibly.
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.18, at + 0.02);
    gain.gain.linearRampToValueAtTime(0, at + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + duration + 0.05);
  }
}

/**
 * Speaks the call's message aloud, resolving when it has finished (including
 * any repeats) so the caller can report the call as ended.
 */
export function speak(call: CallRequest): Promise<void> {
  const synth = globalThis.speechSynthesis;
  if (!synth) return Promise.resolve();

  const repeats = Math.max(1, Math.min(call.repeat ?? 1, 5));
  return new Promise<void>((resolve) => {
    let remaining = repeats;

    const utter = () => {
      const u = new SpeechSynthesisUtterance(call.message);
      u.lang = call.lang ?? 'en-US';
      u.rate = call.rate ?? 1;
      u.pitch = call.pitch ?? 1;
      u.onend = () => {
        if (mine !== speechGeneration) return resolve();
        if (--remaining > 0) utter();
        else resolve();
      };
      // A speech error must still settle the promise, or the call screen
      // would hang open with no way back.
      u.onerror = () => resolve();
      synth.speak(u);
    };

    // Claimed before the flush below, which interrupts whatever was
    // speaking: that utterance's `end` then belongs to a run that is over.
    const mine = ++speechGeneration;
    synth.cancel();
    utter();
  });
}

/**
 * Bumped by `stopSpeaking`, so a run part-way through its repeats stops too.
 *
 * Cancelling an utterance that is currently speaking dispatches `end` rather
 * than `error` in Chromium - which the Electron renderer always is - so a
 * hang-up decremented the repeat counter and started the message again, reading
 * it out to a screen nobody is looking at, and each further cancel only burned
 * one more repeat. The same counter settles a previous call's promise when a
 * second call takes over. The system-speech fallback in the main process has
 * always worked this way.
 */
let speechGeneration = 0;

export function stopSpeaking(): void {
  speechGeneration += 1;
  globalThis.speechSynthesis?.cancel();
}

  /**
   * A ring nobody stops has to stop itself.
   *
   * Every normal ending arrives from somewhere else - the user answering, or
   * the hub sending `call.cancel` when the rung times out. A hub that dies
   * mid-call sends neither, and the ring then continues for as long as the
   * page is open. The Android ringer has always had this backstop; these did
   * not.
   *
   * Bounded by the call's own ring duration plus a margin, so it can only ever
   * fire after the hub should already have spoken - never cutting a long
   * escalation rung short.
   */
export function maxRingMs(ringSeconds?: number): number {
  const requested = Number(ringSeconds);
  const seconds = Number.isFinite(requested) && requested > 0 ? requested : 60;
  // Clamped so neither a missing value nor a hostile one leaves the speaker on
  // for the rest of the day.
  return Math.min(Math.max(seconds + 15, 30), 15 * 60) * 1000;
}
