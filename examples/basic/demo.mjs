/**
 * A miniature "production app" that reports on itself.
 *
 * Run it, pair a device with the printed code, and watch the notifications
 * arrive. Roughly 30 seconds in it places a call, so you can hear the
 * text-to-speech path end to end.
 *
 *   node examples/basic/demo.mjs
 */
import { Notifier } from '@notifyjs/core';

const notify = new Notifier({
  port: Number(process.env.PORT ?? 7741),
  name: 'Checkout Service',
  storeDir: '.notifyjs-demo',
});

await notify.start();

// A fresh hub has nobody to talk to, so offer a code for the first device.
if (notify.devices().length === 0) {
  const { code } = notify.createPairingCode({ role: 'oncall', ttlMs: 30 * 60_000 });
  console.log(`
  ------------------------------------------------------
   Open ${notify.dashboardUrl} and pair with:

        ${code}

   (role: oncall - receives warnings and above, and rings)
  ------------------------------------------------------
`);
}

notify.on('device:online', (d) => console.log(`> ${d.name} is online`));
notify.on('ack', (a) => console.log(`> ${a.deviceId} acknowledged ${a.notificationId}`));

// ---------------------------------------------------------------------
// Pretend the service is doing real work.
// ---------------------------------------------------------------------

await notify.info({ title: 'Checkout service started', channel: 'lifecycle' });

let diskUsage = 71;

setInterval(async () => {
  diskUsage += Math.random() * 4;

  if (diskUsage > 95) {
    // A call reaches a person; a notification only reaches a screen. Escalate
    // when the difference matters.
    const result = await notify.call({
      message: `Warning. The checkout database is at ${Math.round(diskUsage)} percent disk usage. Immediate action is required.`,
      channel: 'db',
      severity: 'critical',
      ringSeconds: 25,
    });

    console.log(`> call ${result.outcome}${result.deviceName ? ` by ${result.deviceName}` : ''}`);

    if (result.outcome !== 'answered') {
      // Nobody picked up, so leave something behind that survives the moment.
      await notify.critical({
        title: 'Nobody answered the disk alert',
        body: `Disk is at ${Math.round(diskUsage)}%. Tried ${result.attempted.length} device(s).`,
        channel: 'db',
        requireAck: true,
      });
    }
    diskUsage = 71;
    return;
  }

  if (diskUsage > 88) {
    await notify.error({
      title: 'Database disk critical',
      body: `${Math.round(diskUsage)}% used on /var/lib/postgresql`,
      channel: 'db',
      requireAck: true,
      actions: [
        { id: 'ack', label: 'On it', style: 'primary' },
        { id: 'snooze', label: 'Snooze 1h' },
      ],
    });
  } else if (diskUsage > 80) {
    await notify.warn({
      title: 'Database disk filling up',
      body: `${Math.round(diskUsage)}% used`,
      channel: 'db',
    });
  } else {
    await notify.info({ title: `Disk at ${Math.round(diskUsage)}%`, channel: 'db' });
  }
}, 6000);

process.on('SIGINT', async () => {
  await notify.info({ title: 'Checkout service shutting down', channel: 'lifecycle' });
  await notify.stop();
  process.exit(0);
});
