import { contextBridge, ipcRenderer } from 'electron';
import type {
  ActiveCall,
  AddSourceInput,
  AppState,
  Bridge,
  ClientPreferences,
  DesktopPreferences,
} from './shared.js';

/**
 * The only surface the window can reach the rest of the computer through.
 *
 * Node stays out of the renderer entirely (`contextIsolation`, no
 * `nodeIntegration`), because that renderer displays titles and bodies written
 * by whatever is sending alerts. This list is deliberately small and concrete -
 * no generic "invoke anything" escape hatch.
 */
const bridge: Bridge = {
  onState(listener: (state: AppState) => void) {
    ipcRenderer.on('state', (_e, state: AppState) => listener(state));
    // The window is usually created after the hubs have connected, so the
    // first snapshot has to be pulled rather than waited for.
    void ipcRenderer.invoke('state').then(listener);
  },

  onCall(listener: (call: ActiveCall | null) => void) {
    ipcRenderer.on('call', (_e, call: ActiveCall | null) => listener(call));
  },

  addSource: (input: AddSourceInput) => ipcRenderer.invoke('source:add', input),
  removeSource: (id: string) => ipcRenderer.invoke('source:remove', id),
  setSourceEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke('source:enabled', id, enabled),

  savePrefs: (patch: Partial<ClientPreferences>) => ipcRenderer.invoke('prefs:save', patch),
  saveDesktopPrefs: (patch: Partial<DesktopPreferences>) =>
    ipcRenderer.invoke('prefs:desktop', patch),

  answerCall: () => ipcRenderer.invoke('call:answer'),
  declineCall: () => ipcRenderer.invoke('call:decline'),
  endCall: () => ipcRenderer.invoke('call:end'),
  speakSystem: (message: string, repeat: number) =>
    ipcRenderer.invoke('call:speak', message, repeat),

  clearFeed: () => ipcRenderer.invoke('feed:clear'),
  setSnooze: (durationMs: number) => ipcRenderer.invoke('snooze', durationMs),
  sync: () => ipcRenderer.invoke('sync'),
  hideWindow: () => ipcRenderer.send('window:hide'),
  quit: () => ipcRenderer.send('quit'),
};

contextBridge.exposeInMainWorld('notifyjs', bridge);
