# Android Mirror

Mirror and control your Android phone from a browser tab: **https://sulavtimsina.com/android-mirror/**

Everything runs in the visitor's browser. The page talks ADB to the phone plugged into *their*
computer over WebUSB, starts scrcpy-server on the phone, decodes its H.264 stream with WebCodecs,
and sends touch, scroll and key input back. There is no backend, and no video or input leaves the computer.

## Using it

1. On the phone: Developer options → **USB debugging** on.
2. Plug it in over USB. If `adb` is installed, run `adb kill-server` first (only one program can claim the USB interface).
3. Open the page in **Chrome or Edge on a computer** (WebUSB is not available in Firefox, Safari or mobile browsers).
4. Press **Connect phone**, choose the phone, then tap **Allow** on the phone's RSA prompt.
   The browser keeps its ADB key in IndexedDB, so "Always allow" works across visits.

Windows may need the phone's ADB USB driver (e.g. Google USB Driver) for WebUSB to see it.

## Development

```sh
npm install
npm run dev       # http://localhost:5173 (WebUSB works on localhost)
npm run build     # static site in dist/
```

Pushing to `main` deploys `dist/` to GitHub Pages (`.github/workflows/deploy.yml`).

## Credits

- [scrcpy](https://github.com/Genymobile/scrcpy) by Genymobile (Apache-2.0). `public/scrcpy-server-v3.3.3` is the unmodified
  release file (sha256 `7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0`).
- [Tango / ya-webadb](https://github.com/yume-chan/ya-webadb) by Simon Chan (MIT) for ADB over WebUSB and the scrcpy client.
  Tango supports scrcpy-server up to 3.3.3, which is why the site ships that version.

## Diagnostics

The page sends anonymous events (browser, OS, phone model, connection steps, errors, whether video
started) to a collector on the maintainer's Mac, published with Tailscale Funnel at
`https://sulavs-macbook-m1-pro.tail3e4538.ts.net/e`. Nothing is sent from localhost, and no screen content,
input, IP address or persistent ID is recorded.

On that Mac:

```sh
npm run watch            # live, formatted event feed (last 20 first)
npm run watch:errors     # only failures
```

- Collector: `telemetry/collector.js`, run by the LaunchAgent `com.sulavtimsina.android-mirror-telemetry`
- Log: `~/android-mirror-telemetry/events.jsonl` (stops growing at 50 MB)
- Stop publishing: `tailscale funnel --https=443 off`
- Stop collector: `launchctl bootout gui/$(id -u)/com.sulavtimsina.android-mirror-telemetry`
