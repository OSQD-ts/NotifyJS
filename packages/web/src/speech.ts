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

  /**
   * Browsers refuse to start audio without a prior user gesture. Calling this
   * from a click (say, "Enable alerts") unlocks the context for later rings.
   */
  async unlock(): Promise<void> {
    this.ctx ??= new AudioContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  start(): void {
    if (this.timer) return;
    const beep = () => {
      if (!this.ctx || this.ctx.state !== 'running') return;
      // Two short tones, the cadence of a desk phone.
      this.tone(this.ctx.currentTime, 0.4);
      this.tone(this.ctx.currentTime + 0.5, 0.4);
    };
    beep();
    this.timer = setInterval(beep, 2000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
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
      u.onend = () => (--remaining > 0 ? utter() : resolve());
      // A speech error must still settle the promise, or the call screen
      // would hang open with no way back.
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
