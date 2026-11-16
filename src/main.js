// Android Mirror: runs ADB over WebUSB in the browser, starts scrcpy-server on the
// visitor's own phone, decodes the H.264 stream with WebCodecs and sends input back.

import { Adb, AdbDaemonTransport } from '@yume-chan/adb';
import { AdbDaemonWebUsbDeviceManager, AdbDaemonWebUsbDevice } from '@yume-chan/adb-daemon-webusb';
import AdbWebCredentialStore from '@yume-chan/adb-credential-web';
import { AdbScrcpyClient, AdbScrcpyOptionsLatest } from '@yume-chan/adb-scrcpy';
import {
  AndroidKeyCode, AndroidKeyEventAction, AndroidMotionEventAction, DefaultServerPath, ScrcpyPointerId,
} from '@yume-chan/scrcpy';
import {
  BitmapVideoFrameRenderer, WebCodecsVideoDecoder, WebGLVideoFrameRenderer,
} from '@yume-chan/scrcpy-decoder-webcodecs';
import { ReadableStream, WritableStream } from '@yume-chan/stream-extra';

// Must match the version of public/scrcpy-server-v3.3.3 (the newest one Tango supports).
const SERVER_URL = new URL('scrcpy-server-v3.3.3', document.baseURI).href;

const KEY_MAP = {
  Enter: AndroidKeyCode.Enter,
  Backspace: AndroidKeyCode.Backspace,
  Delete: AndroidKeyCode.Delete,
  Tab: AndroidKeyCode.Tab,
  Escape: AndroidKeyCode.Escape,
  ArrowUp: AndroidKeyCode.ArrowUp,
  ArrowDown: AndroidKeyCode.ArrowDown,
  ArrowLeft: AndroidKeyCode.ArrowLeft,
  ArrowRight: AndroidKeyCode.ArrowRight,
  Home: AndroidKeyCode.Home,
  End: AndroidKeyCode.End,
  PageUp: AndroidKeyCode.PageUp,
  PageDown: AndroidKeyCode.PageDown,
};

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const statusEl = $('status');
const connectBtn = $('connect');

const credentialStore = new AdbWebCredentialStore('Android Mirror');
let serverBytes = null;
let session = null; // { adb, client, decoder }
let videoW = 0;
let videoH = 0;
const activePointers = new Set();

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = `status ${cls}`;
}

function setBusy(busy) {
  connectBtn.disabled = busy;
}

// ---- Connection -------------------------------------------------------------

async function loadServer() {
  if (!serverBytes) {
    const res = await fetch(SERVER_URL);
    if (!res.ok) throw new Error(`Could not download scrcpy-server (${res.status})`);
    serverBytes = new Uint8Array(await res.arrayBuffer());
  }
  return serverBytes;
}

async function connect() {
  const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
  if (!manager) {
    setStatus('This browser has no WebUSB. Use Chrome or Edge on a computer.', 'error');
    return;
  }
  if (!WebCodecsVideoDecoder.isSupported) {
    setStatus('This browser has no WebCodecs video decoding. Use a recent Chrome or Edge.', 'error');
    return;
  }

  const device = await manager.requestDevice();
  if (!device) return; // user closed the chooser

  setBusy(true);
  let adb;
  try {
    setStatus('Opening USB connection…');
    let connection;
    try {
      connection = await device.connect();
    } catch (err) {
      if (err instanceof AdbDaemonWebUsbDevice.DeviceBusyError) {
        throw new Error('The phone is in use by another program. Run "adb kill-server" (or close Android Studio/scrcpy) and try again.');
      }
      throw err;
    }

    setStatus('Waiting for you to tap "Allow" on the phone…');
    const transport = await AdbDaemonTransport.authenticate({
      serial: device.serial,
      connection,
      credentialStore,
    });
    adb = new Adb(transport);

    setStatus('Starting mirror on the phone…');
    const bytes = await loadServer();
    await AdbScrcpyClient.pushServer(adb, new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }));

    const options = new AdbScrcpyOptionsLatest({
      audio: false,
      control: true,
      tunnelForward: true,
      videoCodec: 'h264',
      maxSize: Number($('maxSize').value),
      videoBitRate: Number($('bitRate').value),
      maxFps: Number($('maxFps').value),
      stayAwake: true,
      clipboardAutosync: false,
      logLevel: 'info',
    }, { version: '3.3.3' });

    const client = await AdbScrcpyClient.start(adb, DefaultServerPath, options);

    // Every stream from the server must be drained, or the ADB connection stalls.
    client.output.pipeTo(new WritableStream({ write: (line) => console.log('[scrcpy]', line) })).catch(() => {});
    client.clipboard?.pipeTo(new WritableStream({ write: () => {} })).catch(() => {});

    const video = await client.videoStream;
    if (!video) throw new Error('The phone did not send a video stream');
    videoW = video.width;
    videoH = video.height;
    video.sizeChanged(({ width, height }) => {
      videoW = width;
      videoH = height;
    });

    const renderer = WebGLVideoFrameRenderer.isSupported
      ? new WebGLVideoFrameRenderer(canvas)
      : new BitmapVideoFrameRenderer(canvas);
    const decoder = new WebCodecsVideoDecoder({ codec: video.metadata.codec, renderer });
    video.stream.pipeTo(decoder.writable).catch((err) => console.warn('Video stream ended', err));

    session = { adb, client, decoder, name: video.metadata.deviceName || device.name };
    $('placeholder').hidden = true;
    connectBtn.textContent = 'Disconnect';
    setStatus(`Live: ${session.name}`, 'live');
    canvas.focus();

    const current = session;
    Promise.race([client.exited, adb.disconnected]).then(() => {
      if (session === current) teardown('Disconnected');
    });
  } catch (err) {
    console.error(err);
    if (adb) adb.close().catch(() => {});
    setStatus(err.message || String(err), 'error');
  } finally {
    setBusy(false);
  }
}

async function teardown(message = 'Not connected') {
  const s = session;
  session = null;
  activePointers.clear();
  connectBtn.textContent = 'Connect phone';
  $('placeholder').hidden = false;
  setStatus(message);
  if (!s) return;
  try { s.decoder.dispose(); } catch { /* ignore */ }
  try { await s.client.close(); } catch { /* ignore */ }
  try { await s.adb.close(); } catch { /* ignore */ }
}

// ---- Input ------------------------------------------------------------------

const controller = () => session?.client.controller;

function send(promise) {
  promise?.catch((err) => console.warn('Control message failed', err));
}

function pressKey(keyCode) {
  const c = controller();
  if (!c) return;
  for (const action of [AndroidKeyEventAction.Down, AndroidKeyEventAction.Up]) {
    send(c.injectKeyCode({ action, keyCode, repeat: 0, metaState: 0 }));
  }
}

function pressBack() {
  const c = controller();
  if (!c) return;
  send(c.backOrScreenOn(AndroidKeyEventAction.Down));
  send(c.backOrScreenOn(AndroidKeyEventAction.Up));
}

function toDevice(ev) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.round(((ev.clientX - rect.left) / rect.width) * videoW);
  const y = Math.round(((ev.clientY - rect.top) / rect.height) * videoH);
  return [Math.max(0, Math.min(videoW - 1, x)), Math.max(0, Math.min(videoH - 1, y))];
}

function touch(ev, action, pressure) {
  const c = controller();
  if (!c || !videoW) return;
  const [x, y] = toDevice(ev);
  send(c.injectTouch({
    action,
    // The mouse acts as a finger; real touch pointers keep their own ids (multi-touch).
    pointerId: ev.pointerType === 'mouse' ? ScrcpyPointerId.Finger : BigInt(ev.pointerId),
    pointerX: x,
    pointerY: y,
    videoWidth: videoW,
    videoHeight: videoH,
    pressure,
    actionButton: 0,
    buttons: 0,
  }));
}

canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

canvas.addEventListener('pointerdown', (ev) => {
  if (!session) return;
  canvas.focus();
  if (ev.pointerType === 'mouse' && ev.button === 2) { pressBack(); return; }
  if (ev.pointerType === 'mouse' && ev.button === 1) { ev.preventDefault(); pressKey(AndroidKeyCode.AndroidHome); return; }
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  canvas.setPointerCapture(ev.pointerId);
  activePointers.add(ev.pointerId);
  touch(ev, AndroidMotionEventAction.Down, 1);
});

canvas.addEventListener('pointermove', (ev) => {
  if (activePointers.has(ev.pointerId)) touch(ev, AndroidMotionEventAction.Move, 1);
});

const endPointer = (ev) => {
  if (activePointers.delete(ev.pointerId)) touch(ev, AndroidMotionEventAction.Up, 0);
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

canvas.addEventListener('wheel', (ev) => {
  const c = controller();
  if (!c || !videoW) return;
  ev.preventDefault();
  const unit = ev.deltaMode === 1 ? 1 : 100; // lines vs pixels; one wheel notch ≈ 1
  const [x, y] = toDevice(ev);
  send(c.injectScroll({
    pointerX: x,
    pointerY: y,
    videoWidth: videoW,
    videoHeight: videoH,
    scrollX: -ev.deltaX / unit,
    scrollY: -ev.deltaY / unit,
    buttons: 0,
  }));
}, { passive: false });

canvas.addEventListener('keydown', async (ev) => {
  const c = controller();
  if (!c) return;
  const mod = ev.ctrlKey || ev.metaKey;
  if (mod && ev.key.toLowerCase() === 'v') {
    ev.preventDefault();
    try {
      const content = await navigator.clipboard.readText();
      if (content) send(c.setClipboard({ sequence: 0n, paste: true, content }));
    } catch (err) {
      setStatus(`Clipboard access was blocked: ${err.message}`, 'error');
    }
    return;
  }
  if (KEY_MAP[ev.key] !== undefined) {
    ev.preventDefault();
    send(c.injectKeyCode({
      action: AndroidKeyEventAction.Down, keyCode: KEY_MAP[ev.key], repeat: ev.repeat ? 1 : 0, metaState: 0,
    }));
    return;
  }
  if (ev.key.length === 1 && !mod && !ev.altKey) {
    ev.preventDefault();
    send(c.injectText(ev.key));
  }
});

canvas.addEventListener('keyup', (ev) => {
  const c = controller();
  if (c && KEY_MAP[ev.key] !== undefined) {
    ev.preventDefault();
    send(c.injectKeyCode({ action: AndroidKeyEventAction.Up, keyCode: KEY_MAP[ev.key], repeat: 0, metaState: 0 }));
  }
});

// ---- Toolbar ----------------------------------------------------------------

const actions = {
  back: pressBack,
  home: () => pressKey(AndroidKeyCode.AndroidHome),
  recents: () => pressKey(AndroidKeyCode.AndroidAppSwitch),
  volup: () => pressKey(AndroidKeyCode.VolumeUp),
  voldown: () => pressKey(AndroidKeyCode.VolumeDown),
  power: () => pressKey(AndroidKeyCode.Power),
  rotate: () => send(controller()?.rotateDevice()),
  notifications: () => send(controller()?.expandNotificationPanel()),
  screenshot: async () => {
    const blob = await session?.decoder.snapshot();
    if (!blob) return;
    const a = document.createElement('a');
    a.download = `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    a.href = URL.createObjectURL(blob);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  fullscreen: () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.querySelector('.stage').requestFullscreen();
  },
};

document.querySelectorAll('.controls button').forEach((btn) => {
  btn.addEventListener('click', () => {
    actions[btn.dataset.action]?.();
    canvas.focus();
  });
});

connectBtn.addEventListener('click', () => (session ? teardown() : connect()));
window.addEventListener('beforeunload', () => { if (session) teardown(); });
