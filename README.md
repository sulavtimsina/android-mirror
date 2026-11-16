# Android Mirror

Mirror and control an Android phone from a browser tab.

The Node server uses `adb` to start the scrcpy server on the phone. It reads the H.264 video stream
and sends it to the browser over a WebSocket. The browser decodes it with WebCodecs and draws it
on a canvas. Mouse, touch, wheel and keyboard input go back as scrcpy control messages.

## Requirements

- macOS/Linux with Node.js 18+
- `adb` and `scrcpy` (the server uses the `scrcpy-server` file that ships with scrcpy):
  `brew install scrcpy android-platform-tools`
- A browser with WebCodecs: Chrome, Edge, or Safari 16.4+
- A phone with **Developer options → USB debugging** enabled (accept the RSA prompt on the phone)

## Run

```sh
npm install
npm start            # http://127.0.0.1:8000
```

Open the page, pick the device, then press **Connect**.

Environment variables: `PORT` (8000), `HOST` (127.0.0.1; set `0.0.0.0` to allow LAN access, but anyone
who can reach it can control the phone), `ADB`, `SCRCPY_SERVER_PATH`, `SCRCPY_VERSION`.

Wireless: `adb tcpip 5555 && adb connect <phone-ip>:5555`, then refresh the device list.

## Controls

| Input | Action |
|---|---|
| Click / drag, touch (multi-touch) | Touch |
| Right click | Back |
| Middle click | Home |
| Mouse wheel | Scroll |
| Typing (after clicking the screen) | Text and keys (Enter, Backspace, arrows, …) |
| Ctrl/⌘+V | Paste the computer's clipboard on the phone |
| Side buttons | Back, Home, Recents, Volume, Power, Rotate, Notifications, Screenshot, Fullscreen |
