/**
 * The blind spot closed with no external service.
 *
 * The hub runs *inside* this process, so it cannot report its own death. The
 * devices paired to it can: each one is told how often it will be heard from,
 * and raises the alarm locally when the silence runs long.
 *
 *     node examples/heartbeat/embedded-watchdog.mjs
 *
 * Pair a phone or a browser, wait for the countdown, and watch the alarm come
 * from the device rather than from here - because by then there is no "here".
 */
import { Notifier } from '@osqd/notifyjs';

const notify = new Notifier({
  name: 'Checkout Service',
  port: Number(process.env.PORT ?? 7741),
  storeDir: '.notifyjs-watchdog-demo',
  deviceWatchdog: { intervalMs: 5_000, graceMs: 5_000 },
});

await notify.start();

if (notify.devices().length === 0) {
  const issued = notify.createPairingCode({ role: 'oncall', ttlMs: 30 * 60_000 });
  console.log(`\n${issued.qr.terminal}\n`);
  console.log(`  Scan that, or open ${notify.dashboardUrl} and enter ${issued.code}\n`);
}

await notify.info({ title: 'Checkout service started', channel: 'lifecycle' });

console.log('Once a device is connected, this process will crash on purpose.');
console.log('Nothing will be sent when it does - that is the point.\n');

let seconds = 30;
const countdown = setInterval(() => {
  if (notify.onlineDeviceIds().length === 0) {
    console.log('waiting for a device to pair...');
    return;
  }
  seconds -= 5;
  if (seconds > 0) {
    console.log(`crashing in ${seconds}s`);
    return;
  }
  clearInterval(countdown);
  console.log('\n*** simulating a crash: no shutdown, no farewell, no final alert ***');
  // Deliberately not notify.stop(): a real crash gets no chance to say goodbye.
  process.exit(1);
}, 5000);

// A clean exit, by contrast, tells every device it was intentional so nobody
// gets paged for a deploy.
process.on('SIGINT', async () => {
  console.log('\nshutting down cleanly - devices will be told this was planned');
  await notify.stop('operator stopped the demo', 15_000);
  process.exit(0);
});
