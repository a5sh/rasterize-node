// render/discord.js — local metrics + rate-limited error reports to the CF hub
//
// Render.com nodes are short-lived containers; the CF worker observes health
// by polling each node's /health endpoint directly, and per the fleet
// architecture nodes NEVER contact Discord webhooks — they only POST
// rate-limited reports to the central CF worker (/report), which relays.
//
// ENV VARS:
//   CF_NODE_ID             optional — display name (must match CF registry id)
//   RENDER_SERVICE_NAME    auto-set by Render.com
//   CF_REPORT_URL          optional — central worker /report endpoint

import os from "node:os";

const NODE_NAME =
  process.env.CF_NODE_ID ||
  process.env.RENDER_SERVICE_NAME ||
  process.env.NODE_NAME ||
  os.hostname();

const CF_REPORT_URL =
  process.env.CF_REPORT_URL || "https://r-cf.spicydevs.xyz/report";

// ── Report rate limiter ───────────────────────────────────────────────────────

const ERR_WINDOW_MS = 5 * 60_000;
const ERR_BURST_MAX = 3;
const ERR_MIN_GAP_MS = 10_000;

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

// ── Stats (mutated by httpServer syncStats) ───────────────────────────────────

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
    // fire-and-forget
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
  // Suppressed — Worker B polls /health; errors are the only node→worker report.
  console.log(`[reporter] Node "${NODE_NAME}" online — health at /health`);
}

export async function notifyOffline(reason = "SIGTERM") {
  stats.status = "offline";
  // Suppressed, same reason as notifyOnline.
  console.log(`[reporter] Node "${NODE_NAME}" shutting down (${reason})`);
}