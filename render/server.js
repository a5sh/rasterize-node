// render/discord.js — local metrics + rate-limited Discord error alerts
//
// CF hub reporting not included — same reasoning as vps/discord.js.
// Render.com nodes are short-lived containers; the CF worker observes health
// by polling each node's /health endpoint directly.
//
// ENV VARS:
//   CF_NODE_ID             optional — display name (must match CF registry id)
//   RENDER_SERVICE_NAME    auto-set by Render.com
//   DISCORD_WEBHOOK_URL    optional — critical errors POST here (rate-limited)

import os from "node:os";

const NODE_NAME =
  process.env.CF_NODE_ID ||
  process.env.RENDER_SERVICE_NAME ||
  process.env.NODE_NAME ||
  os.hostname();

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || null;

// ── Error-post rate limiter ───────────────────────────────────────────────────

const ERR_WINDOW_MS = 5 * 60_000;
const ERR_BURST_MAX = 3;
const ERR_MIN_GAP_MS = 10_000;

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

// ── Discord webhook ───────────────────────────────────────────────────────────

async function _postDiscord(title, description) {
  if (!DISCORD_WEBHOOK || !_canPostDiscord()) return;
  _errCount++;
  _lastPost = Date.now();
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: `Posterium Render — ${NODE_NAME}`,
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
    // fire-and-forget
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function logError(title, description) {
  recordError(description);
  console.error(`[error] ${title}: ${description}`);
  _postDiscord(title, description).catch(() => {});
}

export async function notifyOnline() {
  stats.status = "online";
  console.log(`[reporter] Node "${NODE_NAME}" online — health at /health`);
}

export async function notifyOffline(reason = "SIGTERM") {
  stats.status = "offline";
  console.log(`[reporter] Node "${NODE_NAME}" shutting down (${reason})`);
  await _postDiscord(
    "Node Offline",
    `**${NODE_NAME}** shutting down: \`${reason}\``,
  );
}
