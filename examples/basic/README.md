# Basic example

A fake service that reports its own disk usage, escalating from `info` to a
spoken call as things get worse.

```bash
npm run build          # from the repo root
node examples/basic/demo.mjs
```

Open the printed dashboard URL, enter the pairing code, and leave the tab open.
Within a minute or two you will see notifications arrive; once simulated disk
usage passes 95% the hub places a call and your browser (or phone) rings and
reads the message aloud.
