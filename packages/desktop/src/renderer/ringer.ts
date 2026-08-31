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

    this.deadline = setTimeout(() => this.stop(), maxRingMs(ringSeconds));
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
      u.onend = () => (--remaining > 0 ? utter() : resolve());
      // An engine failure must still settle, or the call screen hangs open
      // with no way back to the feed.
      u.onerror = () => resolve();
      synth.speak(u);
    };
    synth.cancel();
    utter();
  });
}

export function stopSpeaking(): void {
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
