// vps/discord.js — local metrics + rate-limited error reports to the CF hub
//
// ARCHITECTURE: nodes NEVER contact Discord webhooks directly. All alerting
// flows through the central CF worker (r-cf.spicydevs.xyz/report), which
// relays errors into the fleet webhooks. Reports are rate-limited here to
// keep a crash loop (or hostile traffic) from spraying the hub.
//
// ENV VARS:
//   CF_NODE_ID           optional — display name (must match CF registry id if used)
//   CF_REPORT_URL        optional — central worker /report endpoint
//   NODE_NAME            optional — fallback display name
//
// Node health is also observable via:
//   GET /health          — live per-process metrics (pool, queue, uptime)
//   CF worker /health    — fleet-wide EMA scores, in-flight counts

import os from "node:os";

const NODE_NAME =
  process.env.CF_NODE_ID ||
  process.env.NODE_NAME ||
  process.env.SERVER_NAME ||
  os.hostname();

const CF_REPORT_URL =
  process.env.CF_REPORT_URL || "https://r-cf.spicydevs.xyz/report";

// ── Report rate limiter ───────────────────────────────────────────────────────
// Hard cap: at most ERR_BURST_MAX posts per ERR_WINDOW_MS, with a minimum
// gap of ERR_MIN_GAP_MS between consecutive posts.
// Prevents a crash loop from hammering the central worker.

const ERR_WINDOW_MS = 5 * 60_000; // 5-minute window
const ERR_BURST_MAX = 3; // max hub posts per window
const ERR_MIN_GAP_MS = 10_000; // minimum 10 s between posts

let _errCount = 0;
let _errWindowEnd = 0;
let _lastPost = 0;

function _canReport() {
  const now = Date.now();
  if (now > _errWindowEnd) {
    _errCount = 0;
    _errWindowEnd = now + ERR_WINDOW_MS;
  }
  if (_errCount >= ERR_BURST_MAX) return false;
  if (now - _lastPost < ERR_MIN_GAP_MS) return false;
  return true;
}

// ── Stats object (mutated by server.js via syncStats) ─────────────────────────

export const stats = {
  startedAt: Date.now(),
  activeJobs: 0,
  queuedJobs: 0,
  status: "starting",
  lastError: null,
};

// ── Counters ──────────────────────────────────────────────────────────────────

export function recordRequest() {
  /* counted via pool.activeJobs */
}
export function recordJobDuration() {
  /* future: local p95 histogram  */
}
export function recordResvgFail() {
  stats.lastError = { message: "resvg fail", ts: Date.now() };
}
export function recordWsrvFallback() {
  /* logged inline by server */
}
export function recordError(msg) {
  stats.lastError = { message: msg, ts: Date.now() };
}

// ── Central-worker report (fire-and-forget, rate-limited) ─────────────────────

async function _postReport(type, extra = {}) {
  if (!_canReport()) return;
  _errCount++;
  _lastPost = Date.now();
  try {
    await fetch(CF_REPORT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, node: NODE_NAME, ts: Date.now(), ...extra }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // fire-and-forget — never propagate
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function logError(title, description) {
  recordError(description);
  console.error(`[error] ${title}: ${description}`);
  _postReport("error", { title: title.slice(0, 200), message: description?.slice(0, 1000) }); // non-blocking
}

export async function notifyOnline() {
  stats.status = "online";
  // Boot reports are suppressed — Worker B polls /health itself, and every
  // gratuitous POST burns a Cloudflare request event. Errors are the only
  // node→worker report.
  console.log(`[reporter] Node "${NODE_NAME}" online — health at /health`);
}

export async function notifyOffline(reason = "SIGTERM") {
  stats.status = "offline";
  // Suppressed, same reason as notifyOnline.
  console.log(`[reporter] Node "${NODE_NAME}" shutting down (${reason})`);
}