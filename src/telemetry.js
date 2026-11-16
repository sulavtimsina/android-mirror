// Anonymous usage and error reporting. No screen content, input, or persistent identifiers.
// sid is random per page load, so visits cannot be linked together.

const ENDPOINT = 'https://sulavs-macbook-m1-pro.tail3e4538.ts.net/e';

const sid = Math.random().toString(36).slice(2, 8);

function describeClient() {
  const ua = navigator.userAgent;
  const brands = navigator.userAgentData?.brands?.map((b) => b.brand) ?? [];
  const browser = brands.find((b) => /Edge|Chrome|Opera|Brave/i.test(b) && !/Chromium/i.test(b))
    || (/Edg\//.test(ua) && 'Edge') || (/Firefox\//.test(ua) && 'Firefox')
    || (/Chrome\//.test(ua) && 'Chrome') || (/Safari\//.test(ua) && 'Safari') || 'other';
  const os = navigator.userAgentData?.platform
    || (/Windows/.test(ua) && 'Windows') || (/Android/.test(ua) && 'Android') || (/Mac OS X/.test(ua) && 'macOS')
    || (/CrOS/.test(ua) && 'ChromeOS') || (/Linux/.test(ua) && 'Linux') || (/iPhone|iPad/.test(ua) && 'iOS') || 'other';
  return { browser: browser.replace('Google ', '').replace('Microsoft ', ''), os };
}

const client = describeClient();

export function track(type, data = {}) {
  // Skip local development so test runs don't pollute the log.
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    console.debug('[telemetry]', type, data);
    return;
  }
  const body = JSON.stringify({ type, sid, ...client, ...data });
  try {
    // text/plain keeps this a "simple" CORS request (no preflight).
    fetch(ENDPOINT, {
      method: 'POST', body, keepalive: true, mode: 'cors', headers: { 'Content-Type': 'text/plain' },
    }).catch(() => {});
  } catch { /* never let telemetry break the app */ }
}

export function errorInfo(err) {
  return {
    name: err?.name || typeof err,
    message: String(err?.message ?? err).slice(0, 500),
    cause: err?.cause ? String(err.cause.message ?? err.cause).slice(0, 300) : undefined,
  };
}

window.addEventListener('error', (ev) => track('error', { step: 'uncaught', ...errorInfo(ev.error ?? ev.message) }));
window.addEventListener('unhandledrejection', (ev) => track('error', { step: 'unhandled', ...errorInfo(ev.reason) }));
