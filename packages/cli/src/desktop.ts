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
  const title = `${n.severity.toUpperCase()}: ${n.title}`;
  const body = n.body ?? n.channel;

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
  const candidates: [string, string[]][] = pickVoices(call.message);

  for (const [cmd, args] of candidates) {
    let spoke = false;
    for (let i = 0; i < repeats; i++) {
      spoke = await run(cmd, args, { NOTIFYJS_MESSAGE: call.message });
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
    ['spd-say', ['--wait', message]],
    ['espeak-ng', [message]],
    ['espeak', [message]],
  ];
}

/** Terminal fallback, and the primary view when running in the foreground. */
export function printNotification(n: Notification): void {
  const time = new Date(n.ts).toLocaleTimeString();
  const tag = color(n.severity, n.severity.toUpperCase().padEnd(8));
  process.stdout.write(`${dim(time)} ${tag} ${dim('[' + n.channel + ']')} ${n.title}\n`);
  if (n.body) process.stdout.write(`         ${n.body.replace(/\n/g, '\n         ')}\n`);
}

const CODES: Record<Severity, string> = {
  debug: '90',
  info: '36',
  success: '32',
  warning: '33',
  error: '31',
  critical: '35',
};

function color(severity: Severity, text: string): string {
  if (!process.stdout.isTTY) return text;
  return `${CSI}${CODES[severity] ?? '0'}m${text}${CSI}0m`;
}

function dim(text: string): string {
  return process.stdout.isTTY ? `${CSI}90m${text}${CSI}0m` : text;
}
