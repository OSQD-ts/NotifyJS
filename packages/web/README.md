# @osqd/notifyjs-web

The NotifyJS dashboard: the web client a hub serves off its own port, so
`http://localhost:7741` in any browser is a fully paired device.

```bash
npm install @osqd/notifyjs-web
```

**You rarely install this on purpose.** It is a dependency of
[`@osqd/notifyjs`](https://www.npmjs.com/package/@osqd/notifyjs), and the hub
locates it with `require.resolve` at startup. Install it directly only when you
are serving the assets yourself, or vendoring them somewhere the module graph
cannot reach.

## What it is

Plain ES modules and one stylesheet — no bundler, no framework, no build step
at runtime. The protocol build is vendored into `dist/vendor/protocol` and the
bare specifiers rewritten to real paths, because a browser cannot resolve
`@osqd/notifyjs-protocol` and an inline import map would need a CSP exception.

Everything a device does, it does: pairing by code or link, the live feed with
filtering, acknowledgement, device and role management for an admin, a
full-screen call screen that rings and speaks the message aloud through
`speechSynthesis`, and the local watchdog that raises the alarm when the hub
stops being heard from.

## Serving it yourself

The hub takes the directory directly:

```ts
new Notifier({ dashboardDir: '/path/to/notifyjs-web/dist' });
```

or by environment variable, `NOTIFYJS_DASHBOARD_DIR`, or on the command line:

```bash
notifyjs serve --dashboard-dir ./dashboard
```

A packaged single-file binary has no module graph to resolve against, so a
`dashboard/` directory sitting next to the executable is checked too — which is
how the released archives are laid out. Serve it from somewhere else entirely
and it still works: the dashboard connects back to whichever host served it.

Turn it off with `dashboard: false`, or `--no-dashboard`, and the hub serves
the API alone.

## This is also how NotifyJS reaches an iPhone

The dashboard registers for Web Push and its service worker draws the alert
with nothing of ours running — so a closed tab is still a client. Safari has
delivered Web Push since iOS 16.4, but only to a web app added to the home
screen: open the dashboard in Safari, **Share → Add to Home Screen**, open it
from there, and tap *Enable alerts*. No App Store, no Apple Developer account,
no native build.

The hub encrypts each payload to a key the browser generated
([RFC 8291](https://www.rfc-editor.org/rfc/rfc8291)) and signs the request with
its own ([RFC 8292](https://www.rfc-editor.org/rfc/rfc8292)), so the browser's
vendor forwards bytes it cannot read. The endpoint must be `https`.

## Versions

Version tags publish under `latest`; every push to the default branch publishes
a rolling prerelease under `next`. Keep this in step with the hub serving it.

## Documentation

The [project README](https://github.com/OSQD-ts/NotifyJS#readme).

## License

[OSQD Non-Resale License, Version 1.0](https://github.com/OSQD-ts/NotifyJS/blob/main/LICENSE)
— copyright (c) 2026 Michał Płatosz. Use it, modify it, run it in production
including at a business; you may not sell the software itself or offer it to
third parties as a paid hosted product. That summary is not the licence.
