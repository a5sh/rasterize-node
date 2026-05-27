// core/serverlessReporter.js
//
// Metrics reporter for serverless (lambda) rasterizer nodes — Vercel and Netlify.
//
// WHY THIS IS DIFFERENT FROM render/discord.js AND vps/discord.js
// ────────────────────────────────────────────────────────────────
// Long-lived servers (render, vps) use setInterval to flush metrics every 5 min.
// Lambda functions have no persistent timers — every invocation is independent
// and the container may be recycled at any moment.
//
// This module uses a LAZY-FLUSH pattern instead:
//   • Module-level state persists across invocations within a warm container.
//   • After each render, the handler calls maybeReport(nodeName) — a no-op if
//     it's been less than REPORT_INTERVAL_MS since the last flush.
//   • When the threshold is crossed, the window is flushed and POSTed to the
//     CF hub as a fire-and-forget background promise.
//   • On the very first invocation (cold start), an 'online' report is sent
//     immediately so the embed reflects the node coming online.
//
// FIRE-AND-FORGET RELIABILITY
// ────────────────────────────
// The report POST is started before the response is returned. Lambda containers
// typically stay alive for at least a few seconds after a response is sent, so
// the 3-second-timeout fetch usually completes. Missing an occasional report is
// acceptable — the CF cron polls /health every 5 min as a fallback anyway.
//
// USAGE (in vercel/api/rasterize.js and netlify/functions/rasterize.js)
// ──────────────────────────────────────────────────────────────────────
//   import { recordRequest, recordJobDuration, recordError, maybeReport }
//     from '../lib/serverlessReporter.js';
//
//   // At start of each render path:
//   recordRequest();
//
//   // After successful render:
//   recordJobDuration(Date.now() - t0);
//
//   // On render error:
//   recordError();
//
//   // Before returning response (fire-and-forget):
//   maybeReport(NODE_NAME).catch(() => {});

const CF_REPORT_URL =
  process.env.CF_REPORT_URL || "https://r-cf.spicydevs.xyz/report";
const REPORT_INTERVAL_MS = 5 * 60_000; // flush at most every 5 minutes
const FETCH_TIMEOUT_MS = 3_000; // short — don't block lambda teardown
const WINDOW_SIZE = 500; // smaller than long-lived nodes

// ── Module-level state ────────────────────────────────────────────────────────
// Survives across warm invocations. Reset on cold start (module re-evaluation).

const _window = {
  jobDurationsMs: [],
  requests: 0,
  errors: 0,
  resvgFails: 0,
};

let _lastReport = 0;
let _isColdStart = true; // true until first maybeReport() call

// ── Counters ──────────────────────────────────────────────────────────────────

export function recordRequest() {
  _window.requests++;
}

export function recordJobDuration(ms) {
  if (_window.jobDurationsMs.length < WINDOW_SIZE) {
    _window.jobDurationsMs.push(ms);
  }
}

export function recordError() {
  _window.errors++;
}

export function recordResvgFail() {
  _window.resvgFails++;
  _window.errors++;
}

// ── Percentile helpers ────────────────────────────────────────────────────────

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function summarise(arr) {
  if (arr.length === 0)
    return { min: 0, max: 0, p50: 0, p95: 0, p99: 0, avg: 0, n: 0 };
  const s = [...arr].sort((a, b) => a - b);
  const avg = Math.round(s.reduce((a, b) => a + b, 0) / s.length);
  return {
    min: s[0],
    max: s[s.length - 1],
    p50: pct(s, 50),
    p95: pct(s, 95),
    p99: pct(s, 99),
    avg,
    n: s.length,
  };
}

function flushWindow() {
  const snap = {
    ts: Date.now(),
    requests: _window.requests,
    errors: _window.errors,
    resvgFails: _window.resvgFails,
    jobDuration: summarise(_window.jobDurationsMs),
    // CPU/memory are not meaningful for serverless — omitted
  };
  _window.jobDurationsMs = [];
  _window.requests = 0;
  _window.errors = 0;
  _window.resvgFails = 0;
  return snap;
}

// ── Core report sender ────────────────────────────────────────────────────────

async function sendReport(type, nodeName, extra = {}) {
  await fetch(CF_REPORT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, node: nodeName, ts: Date.now(), ...extra }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Call this at the end of every handler invocation (fire-and-forget).
 * On cold start: sends an 'online' report immediately.
 * Subsequently: flushes and reports if REPORT_INTERVAL_MS has elapsed.
 * Otherwise: no-op.
 *
 * @param {string} nodeName  Value of NODE_NAME env var or hardcoded node id
 *                           Must match the id used in CF worker's getNodes()
 *                           e.g. 'vercel-usw' or 'netlify'
 */
export async function maybeReport(nodeName) {
  const now = Date.now();

  if (_isColdStart) {
    _isColdStart = false;
    _lastReport = now;
    // Send online signal — no snapshot yet, no metrics accumulated yet
    await sendReport("online", nodeName).catch(() => {});
    return;
  }

  if (now - _lastReport < REPORT_INTERVAL_MS) return;
  _lastReport = now;

  const snapshot = flushWindow();
  await sendReport("metrics", nodeName, { snapshot }).catch(() => {});
}
