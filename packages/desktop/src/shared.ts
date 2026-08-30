import type {
  CallRequest,
  ClientPreferences,
  Notification,
  Severity,
  SourceState,
} from '@osqd/notifyjs-protocol';

/** A notification, plus which hub it came from and whether it was resolved. */
export interface FeedEntry {
  sourceId: string;
  sourceLabel: string;
  notification: Notification;
  resolvedAt?: number;
}

export interface ActiveCall {
  sourceId: string;
  sourceLabel: string;
  call: CallRequest;
}

/**
 * Settings that only mean something on a computer.
 *
 * Kept beside `ClientPreferences` rather than inside it: that type is the
 * protocol's, shared with the phone and the browser, and neither of those has
 * a login item or a system tray to hide in.
 */
export interface DesktopPreferences {
  launchAtLogin: boolean;
  /** Start hidden in the tray, which is what a login item usually wants. */
  startHidden: boolean;
  /** Bring the window up by itself when a call arrives. */
  raiseOnCall: boolean;
}

export function defaultDesktopPreferences(): DesktopPreferences {
  return { launchAtLogin: false, startHidden: false, raiseOnCall: true };
}

export function normalizeDesktopPreferences(raw: unknown): DesktopPreferences {
  const base = defaultDesktopPreferences();
  if (!raw || typeof raw !== 'object') return base;
  const v = raw as Partial<DesktopPreferences>;
  const bool = (value: unknown, fallback: boolean) =>
    typeof value === 'boolean' ? value : fallback;
  return {
    launchAtLogin: bool(v.launchAtLogin, base.launchAtLogin),
    startHidden: bool(v.startHidden, base.startHidden),
    raiseOnCall: bool(v.raiseOnCall, base.raiseOnCall),
  };
}

/**
 * Everything the window draws, in one object.
 *
 * The main process owns all of it - the connections have to outlive the window
 * being closed to the tray - so the renderer is a pure view over whatever
 * snapshot it was last handed. Pushing the whole thing on every change costs a
 * few kilobytes and removes a category of bug where the two drift apart.
 */
export interface AppState {
  sources: SourceState[];
  feed: FeedEntry[];
  prefs: ClientPreferences;
  desktop: DesktopPreferences;
  activeCall?: ActiveCall;
  /** Epoch millis until which alerts are held, or 0. */
  snoozedUntil: number;
  version: string;
}

export interface AddSourceInput {
  url?: string;
  link?: string;
  code: string;
}

/** What the preload exposes on `window.notifyjs`. */
export interface Bridge {
  /** Fires with the current snapshot immediately, then on every change. */
  onState(listener: (state: AppState) => void): void;
  /** A call has started ringing; the argument is null when it has stopped. */
  onCall(listener: (call: ActiveCall | null) => void): void;

  addSource(input: AddSourceInput): Promise<{ ok: true } | { ok: false; error: string }>;
  removeSource(id: string): Promise<void>;
  setSourceEnabled(id: string, enabled: boolean): Promise<void>;

  savePrefs(patch: Partial<ClientPreferences>): Promise<void>;
  saveDesktopPrefs(patch: Partial<DesktopPreferences>): Promise<void>;

  answerCall(): Promise<void>;
  declineCall(): Promise<void>;
  endCall(): Promise<void>;
  /** Speaks through the OS engine, for machines whose webview has no voices. */
  speakSystem(message: string, repeat: number): Promise<boolean>;

  clearFeed(): Promise<void>;
  setSnooze(durationMs: number): Promise<void>;
  sync(): Promise<void>;
  hideWindow(): void;
  quit(): void;
}

export type { CallRequest, ClientPreferences, Notification, Severity, SourceState };
