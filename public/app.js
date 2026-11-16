// Browser side: decodes the H.264 stream with WebCodecs and sends scrcpy control messages.

const MSG_SESSION = 1;
const MSG_CONFIG = 2;
const MSG_FRAME = 3;

// scrcpy control message types
const CTRL_INJECT_KEYCODE = 0;
const CTRL_INJECT_TEXT = 1;
const CTRL_INJECT_TOUCH = 2;
const CTRL_INJECT_SCROLL = 3;
const CTRL_BACK_OR_SCREEN_ON = 4;
const CTRL_EXPAND_NOTIFICATIONS = 5;
const CTRL_SET_CLIPBOARD = 9;
const CTRL_ROTATE = 11;
const CTRL_RESET_VIDEO = 17;

// Android constants
const ACTION_DOWN = 0;
const ACTION_UP = 1;
const ACTION_MOVE = 2;
const KEYCODE = {
  HOME: 3, BACK: 4, VOLUME_UP: 24, VOLUME_DOWN: 25, POWER: 26, APP_SWITCH: 187,
};
const KEY_MAP = {
  Enter: 66, Backspace: 67, Delete: 112, Tab: 61, Escape: 111,
  ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22,
  Home: 122, End: 123, PageUp: 92, PageDown: 93,
};
const MOUSE_POINTER_ID = -2n; // "generic finger": the mouse acts as a finger

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const ctx = canvas.getContext('2d');
const statusEl = $('status');
const connectBtn = $('connect');
const deviceSel = $('device');

let ws = null;
let decoder = null;
let configBytes = null; // SPS/PPS, prepended to every keyframe
let waitingForKey = true;
let frameCount = 0;
let videoW = 0;
let videoH = 0;
const activePointers = new Set();

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = `status ${cls}`;
}

async function refreshDevices() {
  const prev = deviceSel.value;
  deviceSel.innerHTML = '';
  try {
    const res = await fetch('/api/devices');
    const devices = await res.json();
    if (!res.ok) throw new Error(devices.error);
    for (const d of devices) {
      const opt = document.createElement('option');
      opt.value = d.serial;
      opt.textContent = d.state === 'device' ? d.model : `${d.model} (${d.state})`;
      opt.disabled = d.state !== 'device';
      deviceSel.append(opt);
    }
    if (!devices.length) deviceSel.append(new Option('No devices', ''));
    if ([...deviceSel.options].some((o) => o.value === prev)) deviceSel.value = prev;
  } catch (err) {
    deviceSel.append(new Option('adb error', ''));
    setStatus(err.message, 'error');
  }
}

// ---- Video decoding ---------------------------------------------------------

function* nalUnits(bytes) {
  // Yields NAL unit payloads (without start codes) from an Annex B buffer.
  let i = 0;
  let start = -1;
  while (i + 2 < bytes.length) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      if (start >= 0) yield bytes.subarray(start, i > 0 && bytes[i - 1] === 0 ? i - 1 : i);
      i += 3;
      start = i;
    } else {
      i++;
    }
  }
  if (start >= 0) yield bytes.subarray(start);
}

function codecFromConfig(bytes) {
  for (const nal of nalUnits(bytes)) {
    if ((nal[0] & 0x1f) === 7 && nal.length >= 4) {
      const hex = (b) => b.toString(16).padStart(2, '0');
      return `avc1.${hex(nal[1])}${hex(nal[2])}${hex(nal[3])}`;
    }
  }
  return 'avc1.42e01f';
}

function createDecoder(codec) {
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = new VideoDecoder({
    output: (frame) => {
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      frame.close();
      $('placeholder').hidden = true;
    },
    error: (err) => {
      console.error('Decoder error', err);
      // Recover: new decoder, wait for a fresh keyframe.
      createDecoder(codec);
      sendControl(new Uint8Array([CTRL_RESET_VIDEO]));
    },
  });
  decoder.configure({ codec, optimizeForLatency: true });
  waitingForKey = true;
}

function handleConfig(bytes) {
  configBytes = bytes.slice();
  createDecoder(codecFromConfig(configBytes));
}

function handleFrame(isKey, bytes) {
  if (!decoder || decoder.state !== 'configured') return;
  if (waitingForKey && !isKey) return;
  waitingForKey = false;
  let data = bytes;
  if (isKey && configBytes) {
    data = new Uint8Array(configBytes.length + bytes.length);
    data.set(configBytes, 0);
    data.set(bytes, configBytes.length);
  }
  // Drop delta frames if the decoder falls behind; wait for the next keyframe.
  if (decoder.decodeQueueSize > 10 && !isKey) {
    waitingForKey = true;
    sendControl(new Uint8Array([CTRL_RESET_VIDEO]));
    return;
  }
  decoder.decode(new EncodedVideoChunk({
    type: isKey ? 'key' : 'delta',
    timestamp: (frameCount++) * 16_667,
    data,
  }));
}

// ---- Connection -------------------------------------------------------------

function connect() {
  if (!('VideoDecoder' in window)) {
    setStatus('This browser lacks WebCodecs. Use Chrome, Edge or Safari 16.4+.', 'error');
    return;
  }
  const q = new URLSearchParams({
    serial: deviceSel.value,
    maxSize: $('maxSize').value,
    bitRate: $('bitRate').value,
    maxFps: $('maxFps').value,
  });
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?${q}`);
  ws.binaryType = 'arraybuffer';
  setStatus('Starting server on device…');
  connectBtn.textContent = 'Disconnect';

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'device') setStatus(`Live: ${msg.name}`, 'live');
      else if (msg.type === 'error') setStatus(msg.message, 'error');
      return;
    }
    const bytes = new Uint8Array(ev.data);
    const view = new DataView(ev.data);
    switch (bytes[0]) {
      case MSG_SESSION:
        videoW = view.getUint32(1);
        videoH = view.getUint32(5);
        break;
      case MSG_CONFIG:
        handleConfig(bytes.subarray(1));
        break;
      case MSG_FRAME:
        handleFrame(bytes[1] === 1, bytes.subarray(2));
        break;
      default:
        break;
    }
  };

  ws.onclose = () => {
    if (!statusEl.classList.contains('error')) setStatus('Disconnected');
    connectBtn.textContent = 'Connect';
    ws = null;
    if (decoder && decoder.state !== 'closed') decoder.close();
    decoder = null;
    configBytes = null;
    activePointers.clear();
    $('placeholder').hidden = false;
  };
}

function disconnect() {
  if (ws) ws.close();
}

function sendControl(bytes) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(bytes);
}

// ---- Control message builders -----------------------------------------------

function writePosition(view, offset, x, y) {
  view.setInt32(offset, x);
  view.setInt32(offset + 4, y);
  view.setUint16(offset + 8, videoW);
  view.setUint16(offset + 10, videoH);
}

function touchMessage(action, pointerId, x, y, pressure) {
  const buf = new ArrayBuffer(32);
  const v = new DataView(buf);
  v.setUint8(0, CTRL_INJECT_TOUCH);
  v.setUint8(1, action);
  v.setBigInt64(2, pointerId);
  writePosition(v, 10, x, y);
  v.setUint16(22, Math.round(pressure * 0xffff));
  v.setInt32(24, 0); // action button
  v.setInt32(28, 0); // buttons
  return new Uint8Array(buf);
}

function scrollMessage(x, y, h, vScroll) {
  const toFixed = (val) => Math.max(-0x8000, Math.min(0x7fff, Math.round((val / 16) * 0x8000)));
  const buf = new ArrayBuffer(21);
  const v = new DataView(buf);
  v.setUint8(0, CTRL_INJECT_SCROLL);
  writePosition(v, 1, x, y);
  v.setInt16(13, toFixed(h));
  v.setInt16(15, toFixed(vScroll));
  v.setInt32(17, 0);
  return new Uint8Array(buf);
}

function keyMessage(action, keycode, metaState = 0) {
  const buf = new ArrayBuffer(14);
  const v = new DataView(buf);
  v.setUint8(0, CTRL_INJECT_KEYCODE);
  v.setUint8(1, action);
  v.setInt32(2, keycode);
  v.setInt32(6, 0); // repeat
  v.setInt32(10, metaState);
  return new Uint8Array(buf);
}

function textMessage(text) {
  const enc = new TextEncoder().encode(text);
  const buf = new Uint8Array(5 + enc.length);
  buf[0] = CTRL_INJECT_TEXT;
  new DataView(buf.buffer).setUint32(1, enc.length);
  buf.set(enc, 5);
  return buf;
}

function setClipboardMessage(text, paste) {
  const enc = new TextEncoder().encode(text);
  const buf = new Uint8Array(14 + enc.length);
  const v = new DataView(buf.buffer);
  buf[0] = CTRL_SET_CLIPBOARD;
  v.setBigUint64(1, 0n); // sequence (0 = no ack wanted)
  buf[9] = paste ? 1 : 0;
  v.setUint32(10, enc.length);
  buf.set(enc, 14);
  return buf;
}

function pressKey(keycode) {
  sendControl(keyMessage(ACTION_DOWN, keycode));
  sendControl(keyMessage(ACTION_UP, keycode));
}

function pressBack() {
  sendControl(new Uint8Array([CTRL_BACK_OR_SCREEN_ON, ACTION_DOWN]));
  sendControl(new Uint8Array([CTRL_BACK_OR_SCREEN_ON, ACTION_UP]));
}

// ---- Input ------------------------------------------------------------------

function toDevice(ev) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.round(((ev.clientX - rect.left) / rect.width) * videoW);
  const y = Math.round(((ev.clientY - rect.top) / rect.height) * videoH);
  return [Math.max(0, Math.min(videoW - 1, x)), Math.max(0, Math.min(videoH - 1, y))];
}

const pointerIdFor = (ev) => (ev.pointerType === 'mouse' ? MOUSE_POINTER_ID : BigInt(ev.pointerId));

canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

canvas.addEventListener('pointerdown', (ev) => {
  if (!ws || !videoW) return;
  canvas.focus();
  if (ev.pointerType === 'mouse' && ev.button === 2) { pressBack(); return; }
  if (ev.pointerType === 'mouse' && ev.button === 1) { ev.preventDefault(); pressKey(KEYCODE.HOME); return; }
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  canvas.setPointerCapture(ev.pointerId);
  activePointers.add(ev.pointerId);
  const [x, y] = toDevice(ev);
  sendControl(touchMessage(ACTION_DOWN, pointerIdFor(ev), x, y, 1));
});

canvas.addEventListener('pointermove', (ev) => {
  if (!activePointers.has(ev.pointerId)) return;
  const [x, y] = toDevice(ev);
  sendControl(touchMessage(ACTION_MOVE, pointerIdFor(ev), x, y, 1));
});

const endPointer = (ev) => {
  if (!activePointers.delete(ev.pointerId)) return;
  const [x, y] = toDevice(ev);
  sendControl(touchMessage(ACTION_UP, pointerIdFor(ev), x, y, 0));
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

canvas.addEventListener('wheel', (ev) => {
  if (!ws || !videoW) return;
  ev.preventDefault();
  const unit = ev.deltaMode === 1 ? 1 : 100; // lines vs pixels
  const [x, y] = toDevice(ev);
  sendControl(scrollMessage(x, y, -ev.deltaX / unit, -ev.deltaY / unit));
}, { passive: false });

canvas.addEventListener('keydown', async (ev) => {
  if (!ws) return;
  const mod = ev.ctrlKey || ev.metaKey;
  if (mod && ev.key.toLowerCase() === 'v') {
    ev.preventDefault();
    try {
      const text = await navigator.clipboard.readText();
      if (text) sendControl(setClipboardMessage(text, true));
    } catch (err) {
      setStatus(`Clipboard read blocked: ${err.message}`, 'error');
    }
    return;
  }
  if (KEY_MAP[ev.key] !== undefined) {
    ev.preventDefault();
    sendControl(keyMessage(ACTION_DOWN, KEY_MAP[ev.key]));
    return;
  }
  if (ev.key.length === 1 && !mod && !ev.altKey) {
    ev.preventDefault();
    sendControl(textMessage(ev.key));
  }
});

canvas.addEventListener('keyup', (ev) => {
  if (ws && KEY_MAP[ev.key] !== undefined) {
    ev.preventDefault();
    sendControl(keyMessage(ACTION_UP, KEY_MAP[ev.key]));
  }
});

// ---- Toolbar ----------------------------------------------------------------

const actions = {
  back: pressBack,
  home: () => pressKey(KEYCODE.HOME),
  recents: () => pressKey(KEYCODE.APP_SWITCH),
  volup: () => pressKey(KEYCODE.VOLUME_UP),
  voldown: () => pressKey(KEYCODE.VOLUME_DOWN),
  power: () => pressKey(KEYCODE.POWER),
  rotate: () => sendControl(new Uint8Array([CTRL_ROTATE])),
  notifications: () => sendControl(new Uint8Array([CTRL_EXPAND_NOTIFICATIONS])),
  screenshot: () => {
    const a = document.createElement('a');
    a.download = `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
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

connectBtn.addEventListener('click', () => (ws ? disconnect() : connect()));
$('refresh').addEventListener('click', refreshDevices);

refreshDevices();
