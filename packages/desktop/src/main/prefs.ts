import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  defaultPreferences,
  normalizePreferences,
  type ClientPreferences,
} from '@osqd/notifyjs-protocol';
import {
  defaultDesktopPreferences,
  normalizeDesktopPreferences,
  type DesktopPreferences,
} from '../shared.js';

interface Stored {
  client: ClientPreferences;
  desktop: DesktopPreferences;
}

/**
 * Settings on disk, beside the credentials rather than inside them.
 *
 * Preferences are not secret and are edited constantly; credentials are secret
 * and written once. Keeping them in separate files means a corrupt settings
 * file costs somebody their chosen speech rate, not their pairing with every
 * hub they own.
 */
export class Preferences {
  private state: Stored;

  constructor(
    private readonly path: string,
    fallbackName: string,
  ) {
    this.state = this.read(fallbackName);
  }

  get client(): ClientPreferences {
    return this.state.client;
  }

  get desktop(): DesktopPreferences {
    return this.state.desktop;
  }

  patchClient(patch: Partial<ClientPreferences>): ClientPreferences {
    this.state.client = normalizePreferences(
      { ...this.state.client, ...patch },
      this.state.client.deviceName,
    );
    this.write();
    return this.state.client;
  }

  patchDesktop(patch: Partial<DesktopPreferences>): DesktopPreferences {
    this.state.desktop = normalizeDesktopPreferences({ ...this.state.desktop, ...patch });
    this.write();
    return this.state.desktop;
  }

  private read(fallbackName: string): Stored {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<Stored>;
      return {
        client: normalizePreferences(raw.client, fallbackName),
        desktop: normalizeDesktopPreferences(raw.desktop),
      };
    } catch {
      // Missing or unreadable settings fall back to defaults rather than
      // stopping an alerting app from starting.
      return { client: defaultPreferences(fallbackName), desktop: defaultDesktopPreferences() };
    }
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.state, null, 2));
    } catch {
      // A read-only home directory is not a reason to lose the running app;
      // the settings simply do not survive a restart.
    }
  }
}
