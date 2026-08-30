import { lookup } from 'node:dns/promises';
import { hostname, platform, release } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { SourceManager, type ClientPreferences } from '@osqd/notifyjs-protocol';
import { nodeCrypto } from '@osqd/notifyjs-protocol/node';
import { fileStorage } from './storage.js';
import { Preferences } from './prefs.js';
import type {
  ActiveCall,
  AddSourceInput,
  AppState,
  DesktopPreferences,
  FeedEntry,
} from '../shared.js';

/** Matching the phone: enough history to scroll back through, not a database. */
const FEED_LIMIT = 300;

export interface HubEvents {
  /** The whole snapshot changed; redraw. */
  state(state: AppState): void;
  /** A new alert arrived, worth a system notification. */
  alert(entry: FeedEntry): void;
  /** A call started ringing, or (null) stopped. */
  call(call: ActiveCall | null): void;
}

/**
 * Every hub subscription, owned by the main process.
 *
 * The phone puts this in the JavaScript that draws its screens, because on a
 * phone there is only one process. Here the window can be closed to the tray
 * for days at a time, and an alerting client that stops listening when its
 * window is dismissed is not an alerting client. So the sockets live out here,
 * and the window is a view that comes and goes.
 */
export class Hub {
  private readonly manager: SourceManager;
  private readonly prefs: Preferences;
  private feed: FeedEntry[] = [];
  private activeCall: ActiveCall | undefined;
  private snoozedUntil = 0;
  private sources = [] as AppState['sources'];
  private listeners: Partial<HubEvents> = {};

  constructor(
    private readonly userDataDir: string,
    private readonly version: string,
  ) {
    this.prefs = new Preferences(join(userDataDir, 'preferences.json'), hostname());
    const storage = fileStorage(join(userDataDir, 'credentials.json'));

    this.manager = new SourceManager({
      storage,
      crypto: nodeCrypto,
      // `ws` already implements the four handlers SocketLike asks for.
      createSocket: (url) => new WebSocket(url) as never,
      platform: platform(),
      model: `${platform()} ${release()}`,
      deviceName: () => this.prefs.client.deviceName,
      minSeverity: () => this.prefs.client.minSeverity,
      // A laptop on a train produces the same silence as a dead hub. Asking
      // the resolver first is what stops it paging anyone over lost wifi.
      isOnline: async () => {
        try {
          await lookup('localhost');
          return true;
        } catch {
          return false;
        }
      },
    });

    this.wire();
  }

  on<K extends keyof HubEvents>(event: K, handler: HubEvents[K]): void {
    this.listeners[event] = handler;
  }

  async start(): Promise<void> {
    await this.manager.load();
    this.sources = this.manager.list();
    this.publish();
  }

  snapshot(): AppState {
    return {
      sources: this.sources,
      feed: this.feed,
      prefs: this.prefs.client,
      desktop: this.prefs.desktop,
      activeCall: this.activeCall,
      snoozedUntil: this.snoozedUntil,
      version: this.version,
    };
  }

  /* ------------------------------ commands --------------------------- */

  async addSource(input: AddSourceInput): Promise<void> {
    await this.manager.add(input);
  }

  async removeSource(id: string): Promise<void> {
    await this.manager.remove(id);
  }

  async setSourceEnabled(id: string, enabled: boolean): Promise<void> {
    await this.manager.setEnabled(id, enabled);
  }

  savePrefs(patch: Partial<ClientPreferences>): void {
    this.prefs.patchClient(patch);
    this.publish();
  }

  saveDesktopPrefs(patch: Partial<DesktopPreferences>): void {
    this.prefs.patchDesktop(patch);
    this.publish();
  }

  answerCall(): void {
    const call = this.activeCall;
    if (call) this.manager.answerCall(call.sourceId, call.call.id);
  }

  declineCall(): void {
    const call = this.activeCall;
    if (!call) return;
    this.manager.declineCall(call.sourceId, call.call.id);
    this.clearCall();
  }

  endCall(): void {
    const call = this.activeCall;
    if (!call) return;
    this.manager.endCall(call.sourceId, call.call.id);
    this.clearCall();
  }

  clearFeed(): void {
    this.feed = [];
    this.publish();
  }

  /**
   * Snoozing tells each hub to hold its alerts rather than dropping them on
   * the floor here, so nothing is lost - it arrives when the snooze ends.
   */
  setSnooze(durationMs: number): void {
    if (durationMs > 0) {
      this.manager.snoozeAll(durationMs);
      this.snoozedUntil = Date.now() + durationMs;
    } else {
      this.manager.unsnoozeAll();
      this.snoozedUntil = 0;
    }
    this.publish();
  }

  sync(): void {
    this.manager.syncAll();
  }

  stop(): void {
    this.manager.disconnectAll();
  }

  /* ------------------------------ internals -------------------------- */

  private wire(): void {
    this.manager.on('sources', (sources) => {
      this.sources = sources;
      this.publish();
    });

    this.manager.on('notification', (entry) => {
      // The same alert can arrive twice across a reconnect and replay.
      const duplicate = this.feed.some(
        (e) => e.sourceId === entry.sourceId && e.notification.id === entry.notification.id,
      );
      if (duplicate) return;

      const item: FeedEntry = { ...entry };
      this.feed = [item, ...this.feed].slice(0, FEED_LIMIT);
      this.publish();
      this.listeners.alert?.(item);
    });

    this.manager.on('call', (entry) => {
      this.activeCall = entry;
      this.publish();
      this.listeners.call?.(entry);
    });

    this.manager.on('call.cancel', ({ callId }) => {
      // Another device picked up, or the hub gave up waiting.
      if (this.activeCall?.call.id === callId) this.clearCall();
    });

    this.manager.on('resolve', ({ sourceId, ids }) => {
      let changed = false;
      this.feed = this.feed.map((e) => {
        if (e.sourceId !== sourceId || !ids.includes(e.notification.id) || e.resolvedAt) return e;
        changed = true;
        return { ...e, resolvedAt: Date.now() };
      });
      if (changed) this.publish();
    });

    this.manager.on('service:missing', ({ sourceId, sourceLabel, title, body }) => {
      // A hub that has stopped talking cannot report its own silence, so the
      // watchdog's finding is surfaced as an alert of our own.
      const item: FeedEntry = {
        sourceId,
        sourceLabel,
        notification: {
          id: `watchdog-${sourceId}-${Date.now()}`,
          seq: 0,
          ts: Date.now(),
          channel: 'notifyjs',
          severity: 'critical',
          title,
          body,
        },
      };
      this.feed = [item, ...this.feed].slice(0, FEED_LIMIT);
      this.publish();
      this.listeners.alert?.(item);
    });
  }

  private clearCall(): void {
    this.activeCall = undefined;
    this.publish();
    this.listeners.call?.(null);
  }

  private publish(): void {
    // A snooze that has run out should stop showing as one without waiting for
    // the next alert to arrive.
    if (this.snoozedUntil && this.snoozedUntil <= Date.now()) this.snoozedUntil = 0;
    this.listeners.state?.(this.snapshot());
  }
}
