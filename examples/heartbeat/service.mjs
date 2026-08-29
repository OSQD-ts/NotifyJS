/**
 * The blind spot, demonstrated.
 *
 * Terminal 1 - a hub that outlives the service:
 *
 *     node packages/cli/dist/bin.js serve --port 7741
 *
 * Terminal 2 - a service that checks in:
 *
 *     NOTIFY_PAIRING_CODE=XXXX-XXXX-XXXX node examples/heartbeat/service.mjs
 *
 * Pair a device with the hub, then kill this process with Ctrl-C or `kill -9`.
 * Within a few seconds the hub alerts that the service stopped checking in -
 * an alert the service could not possibly have sent for itself.
 */
import { RemoteNotifier } from '@notifyjs/core';

const notify = new RemoteNotifier({
  url: process.env.NOTIFY_URL ?? 'ws://localhost:7741',
  pairingCode: process.env.NOTIFY_PAIRING_CODE,
  name: 'checkout-service',
});

await notify.info({ title: 'Checkout service started', channel: 'lifecycle' });

// While this process lives, the timer keeps the hub satisfied. The moment it
// stops - crash, hang, power cut - the silence becomes the alert.
await notify.keepAlive('checkout-service', {
  every: '10s',
  grace: '5s',
  severity: 'critical',
  description: 'The checkout service should check in every 10 seconds.',
});

console.log('checking in; kill this process to trigger the alarm');

let processed = 0;
setInterval(async () => {
  processed += Math.floor(Math.random() * 20);
  await notify.info({ title: `Processed ${processed} orders`, channel: 'checkout' });
}, 15_000);

process.on('SIGINT', () => {
  console.log('\nexiting without a clean shutdown - the hub should notice shortly');
  process.exit(0);
});
