// Pretty-prints Android Mirror telemetry events as they arrive.
//   node telemetry/watch.js          follow new events (shows the last 20 first)
//   node telemetry/watch.js --all    print everything, then follow
//   node telemetry/watch.js --errors only errors

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOG_FILE = process.env.LOG_FILE || path.join(os.homedir(), 'android-mirror-telemetry', 'events.jsonl');
const args = new Set(process.argv.slice(2));
const onlyErrors = args.has('--errors');
const color = process.stdout.isTTY;
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);

function format(e) {
  const time = new Date(e.at).toLocaleString();
  const who = `${e.sid ?? '?'} ${e.browser ?? ''}/${e.os ?? ''}`.trim();
  const isError = e.type === 'error' || e.type === 'no_video';
  const label = isError ? paint('31;1', e.type.toUpperCase()) : paint('36', e.type);
  const skip = new Set(['at', 'origin', 'type', 'sid', 'browser', 'os', 'ua']);
  const details = Object.entries(e)
    .filter(([k]) => !skip.has(k))
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('  ');
  return `${paint('2', time)}  ${paint('33', who)}  ${label}  ${details}`;
}

function printLines(text) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (onlyErrors && e.type !== 'error' && e.type !== 'no_video') continue;
      console.log(format(e));
    } catch { /* partial line */ }
  }
}

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '');

const existing = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
printLines((args.has('--all') ? existing : existing.slice(-20)).join('\n'));
console.log(paint('2', `--- watching ${LOG_FILE} ---`));

let offset = fs.statSync(LOG_FILE).size;
fs.watchFile(LOG_FILE, { interval: 1000 }, (cur) => {
  if (cur.size < offset) offset = 0; // file was truncated
  if (cur.size === offset) return;
  const fd = fs.openSync(LOG_FILE, 'r');
  const buf = Buffer.alloc(cur.size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  offset = cur.size;
  printLines(buf.toString('utf8'));
});
