// Receives anonymous usage/error events from the Android Mirror web app and appends
// them to a JSONL file. Listens on localhost only; Tailscale Funnel publishes it.
//
//   PORT (8787)  LOG_FILE (~/android-mirror-telemetry/events.jsonl)

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.PORT || 8787);
const LOG_FILE = process.env.LOG_FILE || path.join(os.homedir(), 'android-mirror-telemetry', 'events.jsonl');
const MAX_BODY = 8 * 1024;
const MAX_LOG_BYTES = 50 * 1024 * 1024; // stop writing past 50 MB
const ALLOWED_ORIGINS = new Set([
  'https://sulavtimsina.com',
  'http://localhost:5173',
  'http://localhost:4173',
]);
const RATE_LIMIT = 120; // events per client per minute

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

const hits = new Map(); // client key -> { count, windowStart }; in memory only, never logged
setInterval(() => hits.clear(), 10 * 60_000).unref();

function rateLimited(key) {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.windowStart > 60_000) {
    hits.set(key, { count: 1, windowStart: now });
    return false;
  }
  h.count += 1;
  return h.count > RATE_LIMIT;
}

// Keep only expected fields, as short strings/numbers/booleans.
function sanitize(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, 2000);
  if (depth > 2 || typeof value !== 'object') return undefined;
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 30)) {
    const s = sanitize(v, depth + 1);
    if (s !== undefined) out[k.slice(0, 40)] = s;
  }
  return out;
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.writeHead(204).end();
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/e' || !ALLOWED_ORIGINS.has(origin)) {
    res.writeHead(404).end();
    return;
  }
  const clientKey = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
  if (rateLimited(clientKey)) {
    res.writeHead(429).end();
    req.resume();
    return;
  }

  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) {
      res.writeHead(413).end();
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    let event;
    try {
      event = sanitize(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (!event || typeof event.type !== 'string') {
      res.writeHead(400).end();
      return;
    }
    const record = { at: new Date().toISOString(), origin, ...event };
    try {
      if (!fs.existsSync(LOG_FILE) || fs.statSync(LOG_FILE).size < MAX_LOG_BYTES) {
        fs.appendFileSync(LOG_FILE, `${JSON.stringify(record)}\n`);
      }
    } catch (err) {
      console.error('write failed', err.message);
    }
    res.writeHead(204).end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`telemetry collector on http://127.0.0.1:${PORT} -> ${LOG_FILE}`);
});
