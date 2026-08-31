import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import type { CallRequest, Notification, Severity } from '@osqd/notifyjs-protocol';

/** CSI introducer, built at runtime to keep a raw escape byte out of source. */
const CSI = String.fromCharCode(27) + '[';

const run = (cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<boolean> =>
  new Promise((resolve) => {
    // Arguments are passed as an array, never through a shell, so a
    // notification title containing shell metacharacters is inert.
    execFile(cmd, args, { env: env ? { ...process.env, ...env } : process.env }, (err) =>
      resolve(!err),
    );
  });

/**
 * Windows toast, via PowerShell.
 *
 * The text is passed through the environment rather than interpolated into the
 * script: notification bodies carry stack traces and user input, and building
 * a script out of them would be a command-injection hole. WinRT toasts are
 * preferred; the balloon fallback covers hosts where the WinRT types are not
 * projected into PowerShell.
 */
const WINDOWS_TOAST = `
$ErrorActionPreference = 'Stop'
$title = $env:NOTIFYJS_TITLE
$body  = $env:NOTIFYJS_BODY
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
  $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
    [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $nodes = $template.GetElementsByTagName('text')
  $nodes.Item(0).AppendChild($template.CreateTextNode($title)) | Out-Null
  $nodes.Item(1).AppendChild($template.CreateTextNode($body)) | Out-Null
  $toast = New-Object Windows.UI.Notifications.ToastNotification $template
  $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  $icon = New-Object System.Windows.Forms.NotifyIcon
  $icon.Icon = [System.Drawing.SystemIcons]::Information
  $icon.Visible = $true
  $icon.ShowBalloonTip(10000, $title, $body, [System.Windows.Forms.ToolTipIcon]::Warning)
  Start-Sleep -Milliseconds 1200
  $icon.Dispose()
}
`;

/**
 * Native desktop notifications, best-effort.
 *
 * The daemon must keep working on a headless box, so a missing `notify-send`
 * is not an error - it just falls through to the terminal renderer.
 */
export async function desktopNotify(n: Notification): Promise<boolean> {
  const title = safeText(`${String(n.severity).toUpperCase()}: ${n.title}`);
  const body = safeText(n.body ?? n.channel);

  if (platform() === 'darwin') {
    return run('osascript', [
      '-e',
      `display notification ${quote(body)} with title ${quote(title)}`,
    ]);
  }

  if (platform() === 'win32') {
    return run(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_TOAST],
      { NOTIFYJS_TITLE: title, NOTIFYJS_BODY: body },
    );
  }

  return run('notify-send', ['--urgency', urgency(n.severity), '--', title, body]);
}

function urgency(severity: Severity): string {
  if (severity === 'critical' || severity === 'error') return 'critical';
  if (severity === 'warning') return 'normal';
  return 'low';
}

/** AppleScript string literal escaping for the osascript path. */
function quote(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * Speaks a call's message with whatever the machine has installed, trying the
 * engines in order of how natural they sound.
 */
export async function speakCall(call: CallRequest): Promise<boolean> {
  const repeats = Math.max(1, Math.min(call.repeat ?? 1, 5));
  // The message is passed as an argument to whichever engine is installed, and
  // a leading dash would be read as an option rather than as words. Stripping
  // it keeps a hub from choosing the flags a local command runs with.
  const message = safeText(String(call.message ?? '')).replace(/^[-\s]+/, '') || 'alert';
  const candidates: [string, string[]][] = pickVoices(message);

  for (const [cmd, args] of candidates) {
    let spoke = false;
    for (let i = 0; i < repeats; i++) {
      spoke = await run(cmd, args, { NOTIFYJS_MESSAGE: message });
      if (!spoke) break;
    }
    if (spoke) return true;
  }
  return false;
}

/** Speech engines to try, most natural first, per platform. */
function pickVoices(message: string): [string, string[]][] {
  if (platform() === 'darwin') return [['say', [message]]];
  if (platform() === 'win32') {
    // SAPI is present on every Windows install, so no fallback is needed.
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
 * Strips control characters from text the hub sent us.
 *
 * Titles and bodies carry stack traces and whatever a monitored service
 * logged, and this is printed straight to an operator's terminal. A raw escape
 * sequence in there can move the cursor, repaint earlier lines, or - on some
 * terminals - stuff characters into the input buffer. Newlines are kept in
 * bodies, which are indented rather than printed flat.
 */
function safeText(value: string, keepNewlines = false): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (keepNewlines && ch === '\n') {
      out += ch;
      continue;
    }
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
  }
  return out;
}

/** Terminal fallback, and the primary view when running in the foreground. */
export function printNotification(n: Notification): void {
  const time = new Date(n.ts).toLocaleTimeString();
  // Sanitised like every other field on this line. It is hub-supplied text on
  // its way to a terminal, and being a short enum by contract is not the same
  // as being one on the wire.
  const tag = color(n.severity, safeText(String(n.severity)).toUpperCase().padEnd(8));
  const channel = safeText(String(n.channel));
  process.stdout.write(`${dim(time)} ${tag} ${dim('[' + channel + ']')} ${safeText(n.title)}\n`);
  if (n.body) {
    const body = safeText(n.body, true).replace(/\n/g, '\n         ');
    process.stdout.write(`         ${body}\n`);
  }
}

/**
 * Null-prototyped: the lookup key arrives from the hub, and a plain object
 * answers `CODES['constructor']` with a function, which would be interpolated
 * straight into the escape sequence below.
 */
const CODES: Record<Severity, string> = Object.assign(Object.create(null), {
  debug: '90',
  info: '36',
  success: '32',
  warning: '33',
  error: '31',
  critical: '35',
});

function color(severity: Severity, text: string): string {
  if (!process.stdout.isTTY) return text;
  return `${CSI}${CODES[severity] ?? '0'}m${text}${CSI}0m`;
}

function dim(text: string): string {
  return process.stdout.isTTY ? `${CSI}90m${text}${CSI}0m` : text;
}
