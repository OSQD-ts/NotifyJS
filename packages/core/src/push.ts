import type { Device, Notification, CallRequest } from '@osqd/notifyjs-protocol';
import type { PushOptions } from './options.js';

/** Expo rejects a request carrying more than this many messages. */
const MAX_BATCH = 100;

/**
 * The Android channel the phone app creates for alerts, at MAX importance.
 *
 * Android takes importance from the channel, not from the message, and a push
 * that names no channel lands on the app's default one. Omitting it left every
 * alert at default importance - no heads-up, and eligible to be held back
 * until the phone next came out of Doze, which reads exactly like the app
 * having missed it. Must stay in step with `setNotificationChannelAsync` in
 * the mobile package.
 */
const ANDROID_CHANNEL = 'alerts';

/**
 * One entry of Expo's response array, in the shape this code depends on.
 * Everything else in a ticket is Expo's business.
 */
interface PushTicket {
  status?: string;
  message?: string;
  details?: { error?: string };
}

/**
 * Wake-up pushes for devices whose socket is closed.
 *
 * Off unless you turn it on, because of what it costs: a notification's title
 * (and its body, if you allow it) travels in the clear through Expo and then
 * Apple or Google. Everything else in this project stays on infrastructure you
 * control; this trades a little of that for reaching a phone whose app has
 * been swiped away.
 *
 * `webpush.ts` is the other wake-up transport and it does not make that trade -
 * the payload is encrypted to a key the browser generated, so the push service
 * forwards bytes it cannot read. That is why it defaults on and this does not.
 */
export class PushSender {
  constructor(
    private readonly opts: PushOptions,
    private readonly log: (line: string, meta?: Record<string, unknown>) => void,
    /** Reports the outcome, so `/metrics` can show pushes actually happening. */
    private readonly onResult: (ok: boolean, count: number) => void = () => {},
    /**
     * A device Expo says it can no longer reach.
     *
     * An uninstalled app leaves a token behind that will never deliver again.
     * Without telling anyone, the hub keeps sending to it on every alert
     * forever - so the one party that can retire it is told.
     */
    private readonly onUnreachable: (deviceId: string) => void = () => {},
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
        channelId: ANDROID_CHANNEL,
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
        channelId: ANDROID_CHANNEL,
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

    // Expo refuses a request carrying more than 100 messages, so a single
    // oversized batch does not deliver *fewer* pushes - it delivers none. A
    // hub with a hundred-and-one phones would silently stop pushing entirely.
    const batches: Device[][] = [];
    for (let i = 0; i < targets.length; i += MAX_BATCH) {
      batches.push(targets.slice(i, i + MAX_BATCH));
    }

    // Sent in parallel: these are wake-ups for an alert that has already been
    // delivered to everyone connected, and serialising them would put the
    // slowest batch in front of every later one.
    await Promise.all(batches.map((batch) => this.postBatch(batch, build, ref)));
  }

  private async postBatch(
    batch: Device[],
    build: (device: Device) => Record<string, unknown>,
    ref: string,
  ): Promise<void> {
    try {
      // A push service being slow must never hold up delivery to the devices
      // that are actually connected, so this is bounded and never awaited by
      // the notify() caller.
      const response = await fetch(this.opts.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(batch.map(build)),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        this.log('push service rejected the request', { status: response.status, ref });
        this.onResult(false, batch.length);
        return;
      }

      this.onResult(true, batch.length);
      await this.reapUnreachable(response, batch, ref);
    } catch (err) {
      this.onResult(false, batch.length);
      this.log('push delivery failed', {
        ref,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Reads the per-message tickets back.
   *
   * A 200 from Expo means the batch was accepted, not that every message in it
   * was deliverable: tokens for an app that has been uninstalled come back as
   * `DeviceNotRegistered`. Ignoring that leaves the hub pushing to a dead token
   * on every alert for the life of the device record.
   */
  private async reapUnreachable(
    response: Response,
    batch: Device[],
    ref: string,
  ): Promise<void> {
    let tickets: PushTicket[] = [];
    try {
      const payload = (await response.json()) as { data?: PushTicket[] };
      tickets = Array.isArray(payload?.data) ? payload.data : [];
    } catch {
      // A body we cannot read is not worth failing an accepted batch over.
      return;
    }

    // Expo returns one ticket per message, in the order they were sent.
    tickets.forEach((ticket, i) => {
      if (ticket?.status !== 'error') return;
      const device = batch[i];
      if (!device) return;
      if (ticket.details?.error === 'DeviceNotRegistered') {
        this.log('clearing a push token the service can no longer reach', {
          ref,
          device: device.id,
        });
        this.onUnreachable(device.id);
        return;
      }
      this.log('push was rejected for one device', {
        ref,
        device: device.id,
        error: ticket.details?.error ?? ticket.message,
      });
    });
  }
}
