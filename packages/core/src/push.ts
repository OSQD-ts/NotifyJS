import type { Device, Notification, CallRequest } from '@notifyjs/protocol';
import type { PushOptions } from './options.js';

/**
 * Wake-up pushes for devices whose socket is closed.
 *
 * This is the one place NotifyJS talks to anybody else's servers, which is why
 * it is off unless you turn it on. When enabled, a notification's title (and
 * its body, if you allow it) travels through Expo and then Apple or Google.
 * Everything else in this project stays on infrastructure you control; this
 * trades a little of that for reaching a phone whose app has been swiped away.
 */
export class PushSender {
  constructor(
    private readonly opts: PushOptions,
    private readonly log: (line: string, meta?: Record<string, unknown>) => void,
  ) {}

  get enabled(): boolean {
    return this.opts.enabled;
  }

  async notify(devices: Device[], n: Notification): Promise<void> {
    await this.post(
      devices,
      (device) => ({
        to: device.pushToken,
        title: `${n.severity.toUpperCase()}: ${n.title}`,
        body: this.opts.includeBody ? (n.body ?? n.channel) : n.channel,
        sound: 'default',
        priority: 'high',
        // The app reconnects on wake and syncs, so the payload only needs to
        // identify what arrived - never to be the source of truth.
        data: { kind: 'notification', id: n.id, seq: n.seq },
      }),
      n.id,
    );
  }

  async call(devices: Device[], c: CallRequest): Promise<void> {
    await this.post(
      devices,
      (device) => ({
        to: device.pushToken,
        title: `Incoming alert from ${c.from}`,
        body: this.opts.includeBody ? c.message : 'Open to answer',
        sound: 'default',
        priority: 'high',
        data: { kind: 'call', id: c.id },
      }),
      c.id,
    );
  }

  private async post(
    devices: Device[],
    build: (device: Device) => Record<string, unknown>,
    ref: string,
  ): Promise<void> {
    const targets = devices.filter((d) => d.pushToken && d.status === 'active');
    if (!this.opts.enabled || targets.length === 0) return;

    try {
      // A push service being slow must never hold up delivery to the devices
      // that are actually connected, so this is bounded and never awaited by
      // the notify() caller.
      const response = await fetch(this.opts.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(targets.map(build)),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        this.log('push service rejected the request', { status: response.status, ref });
      }
    } catch (err) {
      this.log('push delivery failed', {
        ref,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
