import { AppState, Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Network from 'expo-network';
import {
  SourceManager,
  defaultPreferences,
  normalizePreferences,
  type ClientPreferences,
  type SourcedCall,
  type SourceState,
} from '@osqd/notifyjs-protocol';

import {
  addCallActionListener,
  addWakeListener,
  consumeAnsweredCall,
  dismissCall,
  showAlert,
  showIncomingCall,
  startWatching,
  stopWatching,
} from '../modules/notifyjs-call';
import { nobleCrypto } from './crypto';
import {
  addToFeed,
  callAnswered,
  markResolved,
  shouldWatch,
  type FeedEntry,
} from './state';
import { secureStorage } from './storage';

const PREFS_KEY = 'notifyjs_preferences';

export interface HubState {
  sources: SourceState[];
  feed: FeedEntry[];
  activeCall?: SourcedCall;
  /**
   * The call answered from the notification rather than from the call screen.
   *
   * Kept as an id rather than a flag because the answer can land before the
   * call does: tapping Answer on a lock screen is often what starts the app,
   * and the call it refers to only reappears once the hub is resynced.
   */
  answeredCallId?: string;
  prefs: ClientPreferences;
  loaded: boolean;
}

/**
 * Everything this app does that is not drawing.
 *
 * It used to live in `useSources`, which made the hub connection a possession
 * of the React tree: it existed while something was mounted and went away with
 * it. That is the wrong shape for an app whose entire job is to be reachable
 * when nobody is looking at it. It also put a hard ceiling on the phone's
 * recovery after a reboot - `registerRootComponent` only *registers* a
 * component, so a process started by anything other than a person tapping the
 * icon had no mounted tree, therefore no manager, therefore no sockets, and
 * the boot receiver could do no better than ask somebody to open the app.
 *
 * So the connection lives here instead, at module scope, and React subscribes
 * to it. The tree can mount, unmount and remount without the sockets noticing,
 * and a headless entry point can drive exactly the same object.
 */
class HubClient {
  readonly manager: SourceManager;

  private state: HubState = {
    sources: [],
    feed: [],
    prefs: defaultPreferences('Phone'),
    loaded: false,
  };

  private readonly listeners = new Set<() => void>();
  private readonly storage = secureStorage();
  private starting: Promise<void> | undefined;
  private teardown: Array<() => void> = [];

  /**
   * What the foreground service was last told, so it is not restarted on every
   * hub event. `sources` is replaced whenever anything changes, and asking the
   * OS to start an already-running service dozens of times an hour is both
   * wasteful and a good way to be noticed by a battery optimiser.
   */
  private watching = false;

  constructor() {
    this.manager = new SourceManager({
      storage: this.storage,
      crypto: nobleCrypto,
      createSocket: (url) => new WebSocket(url) as never,
      platform: Platform.OS,
      model: Device.modelName ?? undefined,
      // Read through a getter rather than captured, so a preference change
      // applies to the next notification rather than the next restart.
      deviceName: () => this.state.prefs.deviceName,
      minSeverity: () => this.state.prefs.minSeverity,
      // A phone in a tunnel produces the same silence as a dead hub; asking
      // the radio first is what stops it paging anyone over a lost signal.
      isOnline: async () => {
        try {
          const net = await Network.getNetworkStateAsync();
          return Boolean(net.isInternetReachable ?? net.isConnected);
        } catch {
          return false;
        }
      },
    });
  }

  /* ------------------------------ state ----------------------------- */

  getState = (): HubState => this.state;

  /**
   * A new object on every change and the same one otherwise, which is what
   * `useSyncExternalStore` needs to decide whether to re-render.
   */
  private set(patch: Partial<HubState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
    this.applyWatching();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      // Deliberately not disconnecting when the last subscriber leaves. The
      // connection is the product; a screen going away is not a reason to stop
      // being reachable.
    };
  };

  /* ----------------------------- lifecycle -------------------------- */

  /**
   * Connects, once.
   *
   * Idempotent and safe to call from anywhere - a mounting component, a
   * headless task, both in either order - because more than one of those can
   * be the thing that starts this process.
   */
  start(): Promise<void> {
    this.starting ??= this.begin();
    return this.starting;
  }

  private async begin(): Promise<void> {
    this.wire();

    const stored = await this.storage.get(PREFS_KEY);
    let parsed: unknown = null;
    try {
      parsed = stored ? JSON.parse(stored) : null;
    } catch {
      // Unreadable settings fall back to defaults rather than blocking start.
    }
    this.set({ prefs: normalizePreferences(parsed, Device.deviceName ?? 'Phone') });

    await this.manager.load();
    this.set({ loaded: true });
  }

  private wire(): void {
    this.teardown = [
      this.manager.on('sources', (sources) => this.set({ sources })),

      this.manager.on('notification', (entry) => {
        const feed = addToFeed(this.state.feed, entry);
        if (feed !== this.state.feed) this.set({ feed });
        // Posted natively so it arrives whether the app is in front, behind,
        // or the screen is off - a JS scheduler only runs while JS does.
        showAlert(
          `${entry.sourceId}:${entry.notification.id}`,
          `${entry.notification.severity.toUpperCase()}: ${entry.notification.title}`,
          entry.notification.body ?? `${entry.sourceLabel} · ${entry.notification.channel}`,
          { sound: this.state.prefs.sound, vibrate: this.state.prefs.vibrate },
        );
      }),

      this.manager.on('call', (entry) => {
        this.set({ activeCall: entry });
        showIncomingCall({
          id: entry.call.id,
          // Name the hub, since a phone may be watching several.
          from: `${entry.call.from} · ${entry.sourceLabel}`,
          message: entry.call.message,
          severity: entry.call.severity,
        });
      }),

      this.manager.on('call.cancel', ({ callId }) => {
        dismissCall(callId);
        this.set({
          answeredCallId: this.state.answeredCallId === callId ? undefined : this.state.answeredCallId,
          activeCall: this.state.activeCall?.call.id === callId ? undefined : this.state.activeCall,
        });
      }),

      this.manager.on('resolve', ({ sourceId, ids }) =>
        this.set({ feed: markResolved(this.state.feed, sourceId, ids, Date.now()) }),
      ),

      this.manager.on('service:missing', ({ sourceLabel, title, body }) =>
        showAlert(`watchdog-${sourceLabel}`, title, body ?? '', {
          sound: this.state.prefs.sound,
          vibrate: this.state.prefs.vibrate,
        }),
      ),

      // Answer and Decline pressed on the notification itself, which is the
      // only way to act on a call without unlocking the phone first.
      (() => {
        const sub = addCallActionListener(({ action, callId }) => {
          if (action === 'answer') {
            this.set({ answeredCallId: callId });
            return;
          }
          const entry = this.state.activeCall;
          if (entry?.call.id === callId) {
            this.manager.declineCall(entry.sourceId, callId);
            this.set({ activeCall: undefined });
          }
        });
        return () => sub?.remove();
      })(),

      /**
       * Resyncs when the OS says to, which is the only clock that keeps
       * running. Once the phone dozes, `setInterval` and `setTimeout` are
       * deferred against a clock that has stopped, so the client's keepalive
       * never notices the socket a NAT dropped an hour ago and the backoff it
       * queued never fires.
       */
      (() => {
        const sub = addWakeListener(() => this.manager.syncAll());
        return () => sub?.remove();
      })(),

      /**
       * An Answer that started the app arrives as an intent extra, not an
       * event - the broadcast that carried it ran before there was any
       * JavaScript to hear it. Re-read on every return to the foreground,
       * since that is the moment the launch could have happened.
       */
      (() => {
        const take = () => {
          const id = consumeAnsweredCall();
          if (id) this.set({ answeredCallId: id });
        };
        take();
        const sub = AppState.addEventListener('change', (next) => {
          if (next === 'active') {
            take();
            this.manager.syncAll();
          }
        });
        return () => sub.remove();
      })(),
    ];
  }

  /**
   * Starts or stops the foreground service to match what the settings ask for.
   *
   * Driven from state rather than from a React effect, because the thing that
   * decides it - preferences, and whether any source is enabled - now lives
   * here, and because the service must not depend on a screen being mounted.
   */
  private applyWatching(): void {
    if (!this.state.loaded) return;
    const wanted = shouldWatch(this.state.prefs, this.state.sources);
    if (wanted === this.watching) return;
    this.watching = wanted;
    if (wanted) startWatching('NotifyJS');
    else stopWatching();
  }

  /* ------------------------------ actions --------------------------- */

  async savePrefs(patch: Partial<ClientPreferences>): Promise<void> {
    const next = normalizePreferences({ ...this.state.prefs, ...patch }, this.state.prefs.deviceName);
    this.set({ prefs: next });
    await this.storage.set(PREFS_KEY, JSON.stringify(next));
  }

  clearFeed(): void {
    this.set({ feed: [] });
  }

  closeCall(entry?: SourcedCall): void {
    if (entry) dismissCall(entry.call.id);
    this.set({ answeredCallId: undefined, activeCall: undefined });
  }

  /** True when the active call was already answered from the notification. */
  get callAnswered(): boolean {
    return callAnswered(this.state.activeCall, this.state.answeredCallId);
  }

  /**
   * Only for tests and a deliberate shutdown. Nothing in the app calls this:
   * the whole point of the refactor is that going away is not something the
   * connection does on its own.
   */
  stop(): void {
    for (const off of this.teardown) off();
    this.teardown = [];
    this.manager.disconnectAll();
    this.starting = undefined;
  }
}

/**
 * The one connection this process has.
 *
 * A module-scope singleton rather than a context: a headless task has no
 * provider above it, and two managers on one phone would each hold their own
 * socket to every hub and acknowledge the same alerts twice.
 */
export const hub = new HubClient();

export type { FeedEntry };
