import type { ActiveCall, AppState, Bridge, Severity } from '../shared.js';
import { Ringer, speak, stopSpeaking } from './ringer.js';
import { callScreen, feedScreen, pairScreen, settingsScreen, type Actions } from './screens.js';

declare global {
  interface Window {
    notifyjs: Bridge;
  }
}

const bridge = window.notifyjs;
const root = document.getElementById('root')!;
const ringer = new Ringer();

type View = 'feed' | 'settings' | 'add';

let state: AppState | undefined;
let view: View = 'feed';
let filter: Severity | 'all' = 'all';
/** True from the moment a call is answered until it has finished speaking. */
let speaking = false;
/** Guards against answering twice - the button and a keyboard shortcut. */
let answering = false;

const actions: Actions = {
  addSource: async (input) => {
    const result = await bridge.addSource(input);
    if (result.ok) view = 'feed';
    render();
    return result;
  },
  removeSource: (id) => void bridge.removeSource(id),
  setSourceEnabled: (id, enabled) => void bridge.setSourceEnabled(id, enabled),
  savePrefs: (patch) => void bridge.savePrefs(patch as never),
  saveDesktopPrefs: (patch) => void bridge.saveDesktopPrefs(patch as never),
  clearFeed: () => void bridge.clearFeed(),
  setSnooze: (durationMs) => void bridge.setSnooze(durationMs),
  sync: () => void bridge.sync(),
  answer: () => void answer(),
  decline: () => {
    resetCall();
    void bridge.declineCall();
  },
  hangUp: () => {
    stopSpeaking();
    void bridge.endCall();
  },
  navigate: (next) => {
    view = next;
    render();
  },
};

/* -------------------------------- calls ----------------------------- */

/** The call is over, however it ended: ring off, speech off, buttons back. */
function resetCall(): void {
  ringer.stop();
  stopSpeaking();
  answering = false;
  speaking = false;
}

/**
 * Answering, in the order that matters: stop the ring first so the hub is told
 * by a person who can now hear, tell the hub, then read the message out. The
 * call is only reported as ended once there is nothing left to say.
 */
async function answer(): Promise<void> {
  if (answering || !state?.activeCall) return;
  answering = true;
  const { call } = state.activeCall;
  const prefs = state.prefs.speech;

  ringer.stop();
  await bridge.answerCall();

  if (!prefs.enabled) {
    // Answering still counts; the person simply does not want it read out.
    await bridge.endCall();
    resetCall();
    return;
  }

  speaking = true;
  render();

  await speak(
    call.message,
    {
      lang: prefs.lang || call.lang || '',
      rate: prefs.rate || call.rate || 1,
      pitch: prefs.pitch || call.pitch || 1,
      repeat: prefs.repeat || call.repeat || 1,
    },
    bridge.speakSystem,
  );

  await bridge.endCall();
  resetCall();
}

function onCall(call: ActiveCall | null): void {
  if (call) {
    answering = false;
    speaking = false;
    ringer.start(call.call.ringSeconds);
  } else {
    // Cancelled by the hub because another device picked up, or ended here.
    resetCall();
  }
  render();
}

/* ------------------------------- rendering -------------------------- */

/**
 * What a rebuild would throw away.
 *
 * The main process pushes the whole snapshot on every change - a hub
 * reconnecting, an alert arriving, a source going quiet - and each push
 * replaces the entire DOM. Anything the user was in the middle of lives only
 * in that DOM: a half-typed pairing code, the caret inside it, how far down
 * the feed they had scrolled. Without this, a hub reconnecting in the
 * background wipes the code someone is still typing.
 */
interface LiveState {
  focusedId: string;
  value?: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  scroll: Map<string, number>;
}

/** Elements whose scroll position is worth carrying across a rebuild. */
const SCROLLERS = ['feed-list', 'settings-scroll'];

function captureLiveState(): LiveState {
  const scroll = new Map<string, number>();
  for (const id of SCROLLERS) {
    const node = document.getElementById(id);
    if (node && node.scrollTop > 0) scroll.set(id, node.scrollTop);
  }

  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement) || !active.id) {
    return { focusedId: '', selectionStart: null, selectionEnd: null, scroll };
  }
  return {
    focusedId: active.id,
    // The value the person is typing wins over the one state would supply:
    // they are still editing it, and state does not know that yet.
    value: active.value,
    selectionStart: active.selectionStart,
    selectionEnd: active.selectionEnd,
    scroll,
  };
}

function restoreLiveState(live: LiveState): void {
  for (const [id, top] of live.scroll) {
    const node = document.getElementById(id);
    if (node) node.scrollTop = top;
  }

  if (!live.focusedId) return;
  const node = document.getElementById(live.focusedId);
  if (!(node instanceof HTMLInputElement)) return;

  if (live.value !== undefined) node.value = live.value;
  node.focus();
  try {
    node.setSelectionRange(live.selectionStart, live.selectionEnd);
  } catch {
    // Some input types refuse a selection range; focus alone is the point.
  }
}

function render(): void {
  if (!state) return;
  const live = captureLiveState();

  const next = state.activeCall
    ? callScreen(state, actions, speaking)
    : view === 'add' || (view !== 'settings' && state.sources.length === 0)
      ? pairScreen(state, actions)
      : view === 'settings'
        ? settingsScreen(state, actions)
        : feedScreen(state, actions, filter, (value) => {
            filter = value;
            render();
          });

  root.replaceChildren(next);
  restoreLiveState(live);
}

bridge.onState((next) => {
  state = next;
  render();
});

bridge.onCall(onCall);

// Escape gets out of the way without quitting, which is what a tray app's
// window is for. It must never dismiss a ringing call.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || state?.activeCall) return;
  if (view === 'feed') bridge.hideWindow();
  else actions.navigate('feed');
});
