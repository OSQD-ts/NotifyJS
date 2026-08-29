# Catching a dead process

Two ways to be told that the thing that sends your alerts has stopped running.

## 1. No external service: your devices watch the hub

```bash
node examples/heartbeat/embedded-watchdog.mjs
```

The hub runs inside this process. Pair a phone or a browser, then wait: the
demo crashes itself with `process.exit(1)`, sending nothing. A few seconds
later each paired device raises the alarm on its own, because it stopped
hearing a hub that promised to check in.

Press Ctrl-C instead and the hub says goodbye first, so nobody is paged for
what was obviously a planned shutdown.

## 2. A hub that outlives the service

```bash
# Terminal 1 - the hub, on a box that stays up
node packages/cli/dist/bin.js serve --port 7741

# Terminal 2 - the service
NOTIFY_PAIRING_CODE=<code from terminal 1> node examples/heartbeat/service.mjs
```

Pair a browser at <http://localhost:7741>, then `kill -9` the service. No
check-in arrives, and within seconds the hub raises a critical alert. Start it
again and the alert clears itself.

Use both: the first catches the hub dying, the second catches a job that
stopped running.
