import { SEVERITIES, type Severity } from './types.js';

/**
 * Settings a person controls on their own device.
 *
 * Deliberately separate from roles: a role is what the *hub operator* decides
 * you are allowed to see, and these are what *you* decide you want to be
 * bothered by. The two are applied in that order, so no preference can widen
 * what a role permits.
 */
export interface ClientPreferences {
  /** Name this device registers under with each source. */
  deviceName: string;
  /** Hide anything below this, on top of whatever the role already filters. */
  minSeverity: Severity;
  sound: boolean;
  vibrate: boolean;
  /** Keep the connection alive when the app is off screen (Android). */
  keepAlive: boolean;
  /** Speak the message when a call is answered. */
  speech: {
    enabled: boolean;
    /** 1 is the platform default. */
    rate: number;
    pitch: number;
    /** BCP-47 tag, e.g. `en-US`. Empty means whatever the call requests. */
    lang: string;
    /** Times to repeat the spoken message. */
    repeat: number;
  };
}

export function defaultPreferences(deviceName = 'My device'): ClientPreferences {
  return {
    deviceName,
    minSeverity: 'debug',
    sound: true,
    vibrate: true,
    keepAlive: true,
    speech: { enabled: true, rate: 1, pitch: 1, lang: '', repeat: 1 },
  };
}

/**
 * Merges stored settings over the defaults, discarding anything malformed.
 *
 * Preferences are read from device storage that may have been written by an
 * older version, so a missing or nonsensical field must fall back rather than
 * produce an app that will not start.
 */
export function normalizePreferences(
  raw: unknown,
  fallbackName = 'My device',
): ClientPreferences {
  const base = defaultPreferences(fallbackName);
  if (!raw || typeof raw !== 'object') return base;
  const v = raw as Partial<ClientPreferences>;

  return {
    deviceName:
      typeof v.deviceName === 'string' && v.deviceName.trim()
        ? v.deviceName.trim().slice(0, 64)
        : base.deviceName,
    minSeverity:
      typeof v.minSeverity === 'string' && (SEVERITIES as readonly string[]).includes(v.minSeverity)
        ? (v.minSeverity as Severity)
        : base.minSeverity,
    sound: typeof v.sound === 'boolean' ? v.sound : base.sound,
    vibrate: typeof v.vibrate === 'boolean' ? v.vibrate : base.vibrate,
    keepAlive: typeof v.keepAlive === 'boolean' ? v.keepAlive : base.keepAlive,
    speech: {
      enabled: typeof v.speech?.enabled === 'boolean' ? v.speech.enabled : base.speech.enabled,
      rate: clamp(v.speech?.rate, 0.5, 2, base.speech.rate),
      pitch: clamp(v.speech?.pitch, 0.5, 2, base.speech.pitch),
      lang: typeof v.speech?.lang === 'string' ? v.speech.lang.slice(0, 16) : base.speech.lang,
      repeat: Math.round(clamp(v.speech?.repeat, 1, 5, base.speech.repeat)),
    },
  };
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
