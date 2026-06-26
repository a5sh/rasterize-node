// vps/discord.js — local metrics + rate-limited Discord error alerts
//
// CF HUB REPORTING DELIBERATELY REMOVED.
//
// Previously, notifyOnline() / setInterval metrics posted to
// https://r-cf.spicydevs.xyz/report — a route that doesn't exist on the CF
// worker. Every POST fell through to the rasterize handler, which attempted
// a full node-pool raster run, burning 5 s per attempt × N nodes × M restarts.
// This caused the timeout flood visible in the Pterodactyl logs and put
// significant load on the render pool.
//
// Node health is now observable via:
//   GET /health          — live per-process metrics (pool, queue, uptime)
//   CF worker /health    — fleet-wide EMA scores, in-flight counts
//   Discord webhook      — critical errors only, rate-limited (see below)
//
// ENV VARS:
//   CF_NODE_ID           optional — display name (must match CF registry id if used)
//   DISCORD_WEBHOOK_URL  optional — if set, critical errors POST here (rate-limited)

import os from "node:os";

const NODE_NAME =
  process.env.CF_NODE_ID ||
  process.env.NODE_NAME ||
  process.env.SERVER_NAME ||
  os.hostname();

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || null;

// ── Error-post rate limiter ───────────────────────────────────────────────────
// Hard cap: at most ERR_BURST_MAX posts per ERR_WINDOW_MS, with a minimum
// gap of ERR_MIN_GAP_MS between consecutive posts.
// Prevents a crash loop from spamming the webhook.

const ERR_WINDOW_MS = 5 * 60_000; // 5-minute window
const ERR_BURST_MAX = 3; // max Discord posts per window
const ERR_MIN_GAP_MS = 10_000; // minimum 10 s between posts

let _errCount = 0;
let _errWindowEnd = 0;
let _lastPost = 0;

function _canPostDiscord() {
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

// ── Discord webhook (fire-and-forget, rate-limited) ───────────────────────────

async function _postDiscord(title, description) {
  if (!DISCORD_WEBHOOK || !_canPostDiscord()) return;
  _errCount++;
  _lastPost = Date.now();
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: `Posterium VPS — ${NODE_NAME}`,
        embeds: [
          {
            title,
            description: description?.slice(0, 2000),
            color: 0xf87171,
            timestamp: new Date().toISOString(),
            footer: { text: NODE_NAME },
          },
        ],
      }),
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
  _postDiscord(title, description).catch(() => {}); // non-blocking
}

export async function notifyOnline() {
  stats.status = "online";
  console.log(`[reporter] Node "${NODE_NAME}" online — health at /health`);
  // No CF hub call. Fleet status is read by the CF worker polling /health directly.
}

export async function notifyOffline(reason = "SIGTERM") {
  stats.status = "offline";
  console.log(`[reporter] Node "${NODE_NAME}" shutting down (${reason})`);
  await _postDiscord(
    "Node Offline",
    `**${NODE_NAME}** shutting down: \`${reason}\``,
  );
}
