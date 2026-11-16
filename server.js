// Android Mirror: bridges an Android device (via adb + scrcpy-server) to a browser over WebSocket.
//
// Flow per browser session:
//   1. push scrcpy-server.jar to the device
//   2. adb forward tcp:<port> -> localabstract:scrcpy_<scid>
//   3. start the server on the device with app_process
//   4. open the video socket, then the control socket
//   5. parse the video stream into packets and relay them to the browser;
//      relay control messages from the browser to the control socket

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '127.0.0.1';
const ADB = process.env.ADB || 'adb';
const DEVICE_JAR = '/data/local/tmp/scrcpy-server-mirror.jar';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Message types sent to the browser (first byte of each binary message).
const MSG_SESSION = 1; // [u32 width][u32 height]
const MSG_CONFIG = 2; // [codec config bytes: SPS/PPS, Annex B]
const MSG_FRAME = 3; // [u8 keyframe][Annex B frame bytes]

function findServerJar() {
  if (process.env.SCRCPY_SERVER_PATH) return process.env.SCRCPY_SERVER_PATH;
  const candidates = [];
  try {
    const prefix = execFileSync('brew', ['--prefix'], { encoding: 'utf8' }).trim();
    candidates.push(path.join(prefix, 'share/scrcpy/scrcpy-server'));
  } catch { /* brew not available */ }
  candidates.push('/opt/homebrew/share/scrcpy/scrcpy-server', '/usr/local/share/scrcpy/scrcpy-server',
    '/usr/share/scrcpy/scrcpy-server', path.join(__dirname, 'scrcpy-server'));
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('scrcpy-server not found. Install scrcpy or set SCRCPY_SERVER_PATH.');
  return found;
}

function findServerVersion() {
  if (process.env.SCRCPY_VERSION) return process.env.SCRCPY_VERSION;
  const out = execFileSync('scrcpy', ['--version'], { encoding: 'utf8' });
  const m = out.match(/scrcpy\s+(\d+\.\d+(?:\.\d+)?)/);
  if (!m) throw new Error('Could not read scrcpy version. Set SCRCPY_VERSION.');
  return m[1];
}

const SERVER_JAR = findServerJar();
const SERVER_VERSION = findServerVersion();

async function adb(args, serial) {
  const full = serial ? ['-s', serial, ...args] : args;
  const { stdout } = await execFileP(ADB, full, { maxBuffer: 1 << 20 });
  return stdout;
}

async function listDevices() {
  const out = await adb(['devices', '-l']);
  return out.split('\n').slice(1).map((l) => l.trim()).filter(Boolean).map((line) => {
    const [serial, state, ...rest] = line.split(/\s+/);
    const model = rest.find((r) => r.startsWith('model:'))?.slice(6).replace(/_/g, ' ');
    return { serial, state, model: model || serial };
  });
}

function connectWithDummyByte(port, attempts = 100) {
  // With adb forward, connect() succeeds even before the device server listens;
  // the dummy byte proves the device side is really connected.
  return new Promise((resolve, reject) => {
    const tryOnce = (left) => {
      const sock = net.connect(port, '127.0.0.1');
      let done = false;
      const retry = () => {
        if (done) return;
        done = true;
        sock.destroy();
        if (left <= 0) reject(new Error('Could not connect to scrcpy server on device'));
        else setTimeout(() => tryOnce(left - 1), 100);
      };
      sock.once('data', (chunk) => {
        done = true;
        sock.removeAllListeners('error');
        sock.removeAllListeners('close');
        sock.pause();
        resolve({ sock, rest: chunk.subarray(1) });
      });
      sock.once('error', retry);
      sock.once('close', retry);
    };
    tryOnce(attempts);
  });
}

function connectPlain(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => resolve(sock));
    sock.once('error', reject);
  });
}

// Incremental parser for the scrcpy v5 video socket (after the dummy byte).
class VideoStreamParser {
  constructor(handlers) {
    this.h = handlers;
    this.buf = Buffer.alloc(0);
    this.state = 'meta';
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.state === 'meta') {
        if (this.buf.length < 68) return;
        const name = this.buf.subarray(0, 64).toString('utf8').replace(/\0.*$/s, '');
        const codecId = this.buf.readUInt32BE(64);
        this.buf = this.buf.subarray(68);
        this.state = 'packets';
        this.h.onMeta(name, codecId);
        continue;
      }
      if (this.buf.length < 12) return;
      if (this.buf[0] & 0x80) {
        // Session packet: new capture session (e.g. rotation).
        const width = this.buf.readUInt32BE(4);
        const height = this.buf.readUInt32BE(8);
        this.buf = this.buf.subarray(12);
        this.h.onSession(width, height);
        continue;
      }
      const size = this.buf.readUInt32BE(8);
      if (this.buf.length < 12 + size) return;
      const flags = this.buf[0];
      const payload = this.buf.subarray(12, 12 + size);
      this.buf = this.buf.subarray(12 + size);
      if (flags & 0x40) this.h.onConfig(payload);
      else this.h.onFrame(payload, Boolean(flags & 0x20));
    }
  }
}

async function startMirror(ws, params) {
  const devices = (await listDevices()).filter((d) => d.state === 'device');
  if (!devices.length) throw new Error('No Android device found. Connect a phone with USB debugging enabled.');
  const device = params.serial ? devices.find((d) => d.serial === params.serial) : devices[0];
  if (!device) throw new Error(`Device ${params.serial} not found`);
  const serial = device.serial;

  const scid = Math.floor(Math.random() * 0x7fffffff);
  const scidHex = scid.toString(16).padStart(8, '0');
  const cleanup = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const fn of cleanup.reverse()) { try { fn(); } catch { /* ignore */ } }
    if (ws.readyState === ws.OPEN) ws.close();
  };
  ws.on('close', close);

  try {
    await adb(['push', SERVER_JAR, DEVICE_JAR], serial);
    const port = Number((await adb(['forward', 'tcp:0', `localabstract:scrcpy_${scidHex}`], serial)).trim());
    cleanup.push(() => execFile(ADB, ['-s', serial, 'forward', '--remove', `tcp:${port}`], () => {}));

    const opts = [
      `scid=${scidHex}`, 'log_level=info', 'tunnel_forward=true', 'audio=false', 'control=true',
      'video_codec=h264', `max_size=${params.maxSize}`, `video_bit_rate=${params.bitRate}`,
      `max_fps=${params.maxFps}`, 'clipboard_autosync=false', 'cleanup=false', 'stay_awake=true',
    ];
    const proc = spawn(ADB, ['-s', serial, 'shell', `CLASSPATH=${DEVICE_JAR}`, 'app_process', '/',
      'com.genymobile.scrcpy.Server', SERVER_VERSION, ...opts]);
    const log = (d) => process.stdout.write(`[device ${serial}] ${d}`);
    proc.stdout.on('data', log);
    proc.stderr.on('data', log);
    proc.on('exit', () => close());
    cleanup.push(() => proc.kill());

    const { sock: video, rest } = await connectWithDummyByte(port);
    cleanup.push(() => video.destroy());
    const control = await connectPlain(port);
    cleanup.push(() => control.destroy());
    control.on('data', () => { /* device messages (clipboard etc.) are not used */ });
    control.on('error', close);
    control.on('close', close);

    const send = (type, ...parts) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(Buffer.concat([Buffer.from([type]), ...parts]));
    };
    const parser = new VideoStreamParser({
      onMeta: (name, codecId) => {
        if (codecId !== 0x68323634) {
          ws.send(JSON.stringify({ type: 'error', message: `Unexpected codec 0x${codecId.toString(16)}` }));
          close();
          return;
        }
        ws.send(JSON.stringify({ type: 'device', name, serial }));
      },
      onSession: (w, h) => {
        const b = Buffer.alloc(8);
        b.writeUInt32BE(w, 0);
        b.writeUInt32BE(h, 4);
        send(MSG_SESSION, b);
      },
      onConfig: (payload) => send(MSG_CONFIG, payload),
      onFrame: (payload, key) => send(MSG_FRAME, Buffer.from([key ? 1 : 0]), payload),
    });
    if (rest.length) parser.push(rest);
    video.on('data', (c) => parser.push(c));
    video.on('error', close);
    video.on('close', close);
    video.resume();

    ws.on('message', (data, isBinary) => {
      if (isBinary && !control.destroyed) control.write(data);
    });
  } catch (err) {
    close();
    throw err;
  }
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/devices') {
    try {
      const devices = await listDevices();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(devices));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const int = (k, def, min, max) => Math.min(max, Math.max(min, Number.parseInt(q.get(k), 10) || def));
  const params = {
    serial: q.get('serial') || '',
    maxSize: int('maxSize', 1280, 0, 4096),
    bitRate: int('bitRate', 8_000_000, 500_000, 50_000_000),
    maxFps: int('maxFps', 60, 1, 120),
  };
  startMirror(ws, params).catch((err) => {
    console.error('Mirror failed:', err.message);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
      ws.close();
    }
  });
});

httpServer.listen(PORT, HOST, () => {
  console.log(`Android Mirror on http://${HOST}:${PORT}  (scrcpy-server ${SERVER_VERSION}: ${SERVER_JAR})`);
});
