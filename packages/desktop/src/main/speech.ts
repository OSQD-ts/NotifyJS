import { execFile } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Speaking through whatever engine the operating system already has.
 *
 * This is the fallback, not the first choice: the window's own
 * `speechSynthesis` honours the rate and pitch someone set in Settings, and
 * this does not. But a Linux desktop whose Chromium has no voices installed
 * would otherwise answer a call in silence, which is the one outcome a call
 * must never have.
 */
const run = (cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<boolean> =>
  new Promise((resolve) => {
    // Arguments are passed as an array, never through a shell, so a message
    // containing shell metacharacters is inert.
    execFile(cmd, args, { env: env ? { ...process.env, ...env } : process.env }, (err) =>
      resolve(!err),
    );
  });

/** Engines to try, most natural first, per platform. */
function engines(message: string): [string, string[]][] {
  if (platform() === 'darwin') return [['say', [message]]];
  if (platform() === 'win32') {
    // SAPI is on every Windows install, so there is nothing to fall back to.
    return [
      [
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Add-Type -AssemblyName System.Speech; ' +
            '(New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak($env:NOTIFYJS_MESSAGE)',
        ],
      ],
    ];
  }
  return [
    ['spd-say', ['--wait', '--', message]],
    ['espeak-ng', [message]],
    ['espeak', [message]],
  ];
}

/**
 * Strips what a speech engine would read as instructions rather than words.
 *
 * The message comes from a hub over the network and is handed to a local
 * command as its first argument. A leading dash makes it an option instead:
 * `say`, `espeak` and `spd-say` all accept flags that write files or load
 * config, so a hub would be choosing the switches a command on this machine
 * runs with. Control characters go too - they are not speech, and the same
 * text reaches logs.
 */
function safeMessage(value: string): string {
  let out = '';
  for (const ch of String(value ?? '')) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
  }
  return out.replace(/^[-\s]+/, '').trim() || 'alert';
}

/** Speaks `message` `repeat` times, resolving false when nothing could speak. */
export async function speakSystem(raw: string, repeat: number): Promise<boolean> {
  const message = safeMessage(raw);
  const times = Math.max(1, Math.min(repeat, 5));
  for (const [cmd, args] of engines(message)) {
    let spoke = false;
    for (let i = 0; i < times; i++) {
      spoke = await run(cmd, args, { NOTIFYJS_MESSAGE: message });
      // A missing binary fails on the first pass; move to the next engine
      // rather than repeating a failure five times.
      if (!spoke) break;
    }
    if (spoke) return true;
  }
  return false;
}
