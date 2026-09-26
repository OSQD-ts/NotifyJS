/**
 * The ring, synthesised rather than shipped.
 *
 * A WebAudio oscillator keeps the app a single bundle with no binary payload
 * and no codec to license, and it cannot be silenced by a missing asset. The
 * cadence is two short tones every two seconds - a desk phone, not a klaxon.
 */
export class Ringer {
  private ctx: AudioContext | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;

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
    // Constructed lazily: an AudioContext made before the window is shown
    // starts suspended on some platforms and never recovers on its own.
    this.ctx ??= new AudioContext();
    void this.ctx.resume();

    const ring = () => {
      const ctx = this.ctx;
      if (!ctx || ctx.state !== 'running') return;
      this.tone(ctx.currentTime, 0.4);
      this.tone(ctx.currentTime + 0.5, 0.4);
    };
    ring();
    this.timer = setInterval(ring, 2000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = undefined;
  }

  private tone(at: number, duration: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    // Ramped rather than gated: switching a gain node from 0 to full clicks.
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.18, at + 0.02);
    gain.gain.linearRampToValueAtTime(0, at + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + duration + 0.05);
  }
}

/**
 * Speaks the message, preferring the window's own engine so the rate and pitch
 * chosen in Settings are honoured. A desktop whose webview has no voices
 * installed - a common state on Linux - falls back to the system engine
 * through the main process, because a call answered in silence is a call that
 * failed.
 */
export async function speak(
  message: string,
  opts: { lang: string; rate: number; pitch: number; repeat: number },
  systemFallback: (message: string, repeat: number) => Promise<boolean>,
): Promise<void> {
  const synth = globalThis.speechSynthesis;
  const repeats = Math.max(1, Math.min(opts.repeat, 5));

  if (!synth || synth.getVoices().length === 0) {
    await systemFallback(message, repeats);
    return;
  }

  await new Promise<void>((resolve) => {
    let remaining = repeats;
    const utter = () => {
      const u = new SpeechSynthesisUtterance(message);
      if (opts.lang) u.lang = opts.lang;
      u.rate = opts.rate;
      u.pitch = opts.pitch;
      u.onend = () => {
        if (mine !== speechGeneration) return resolve();
        if (--remaining > 0) utter();
        else resolve();
      };
      // An engine failure must still settle, or the call screen hangs open
      // with no way back to the feed.
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
