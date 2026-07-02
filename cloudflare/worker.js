// cloudflare/worker.js — v13
//
// PURE LOAD BALANCER — No WASM, No Puppeteer
//
// Thin entry point wiring together cloudflare/lib/*:
//   nodeRegistry.js  — T1/T2 node views + settings, derived from assets/nodes.config.js
//   health.js        — per-isolate node health/error/perf state + FleetHealth DO bridge
//   geoRouting.js     — CF colo → region mapping, geo+score node ordering
//   nodeAttempt.js    — single-node raster attempt (URL-payload / POST, gzip)
//   embedding.js      — single-poster embed (CF-cache-backed) + outcome analytics
//   metricsWriter.js  — RASTER_METRICS Analytics Engine write helpers
//   raceDispatch.js   — the full distributed-render orchestration
//   dashboard.js      — hourly Discord fleet dashboard + health-check CORS proxy
//
// Worker A builds SVG (icons expanded, poster as href URL) and sends to Worker B.
// Worker B fetches the poster image ONCE, embeds it, then distributes to nodes.
//
// Header contract (Worker A → Worker B):
//   X-Poster-Url          poster image URL → Worker B embeds once
//   X-SVG-Url             canonical .svg URL (wsrv / Vercel URL-payload path)
//   X-CF-Colo             requesting CF datacenter for geo routing
//   X-Format              png | jpg | webp
//   X-Fallback-Image-Url  TMDB direct URL — used for last-resort 302
//   X-Input-Type          movie | tv | anime (analytics only)
//   X-Request-Id          trace ID
//
// Response headers (Worker B → Worker A):
//   X-Raster-Source       winning node id
//   X-Attempt-Count       total node attempts made
//   X-Wall-Ms             total wall time ms
//   X-Poster-Embed-Ms     time to fetch & embed poster
//   X-Node-Score          winning node's current EMA score (lower = faster)
//   X-LB-Version          lb version string
//
// ── T1 Pool (geo+score ordered, tried first, 2-at-a-time races) ──────────────
//   washington  Vercel US East      — URL-payload (GET ?url=)
//   ohio        Netlify US Central  — POST body
//   midas       Spaceify DE2        — POST body
//   germany     Spaceify DE20       — POST body
//   danbot      DanBot EU           — POST body
//   wsrv        wsrv.nl Global      — URL-payload (librsvg) — always in the pool
//
// ── T2 Pool (extreme fallback only, tried after T1 + 5s hard wall exhausted) ──
//   france      Spaceify FR         — POST body
//   render_eu   Render EUC          — POST body
//
// See cloudflare/lib/metricsWriter.js for the RASTER_METRICS analytics schema.

import { T1_NODES, T2_NODES, SETTINGS } from "./lib/nodeRegistry.js";
import { createHealthState } from "./lib/health.js";
import { distributedRender } from "./lib/raceDispatch.js";
import {
  updateDashboard,
  fetchNodeHealth,
  getLastDashboardUpdate,
} from "./lib/dashboard.js";

// ── Structured logger ──────────────────────────────────────────────────────────

function _log(level, event, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    lb: "cf-v13",
    ...meta,
  };
  (level === "error" ? console.error : console.log)(JSON.stringify(entry));
}

// Reserved for secrets_store_secrets-style bindings (see the other
// wrangler.jsonc's CF_ACCOUNT_ID/CF_API_TOKEN pattern). Not currently
// called — DISCORD_WEBHOOK_URL is read as a plain var — preserved as-is.
async function resolveSecret(binding) {
  if (!binding) return null;
  if (typeof binding === "string") return binding;
  if (typeof binding.get === "function") {
    try {
      return await binding.get();
    } catch {
      return null;
    }
  }
  return null;
}

// ── Shared per-isolate health state ──────────────────────────────────────────

const health = createHealthState({
  errWindowMs: SETTINGS.errWindowMs,
  stressThreshold: SETTINGS.stressThreshold,
  failingThreshold: SETTINGS.failingThreshold,
});

// ── JSON helpers ──────────────────────────────────────────────────────────────

function _jsonOk(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
function _jsonError(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ── Main export ────────────────────────────────────────────────────────────────
export { FleetHealth } from "./fleetHealth.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": [
            "Content-Type",
            "X-Format",
            "X-SVG-Encoding",
            "X-SVG-Url",
            "X-CF-Colo",
            "X-Fallback-Image-Url",
            "X-Poster-Url",
            "X-Input-Type",
            "X-Request-Id",
          ].join(", "),
        },
      });
    }

    // ── /health ────────────────────────────────────────────────────────────
    if (url.pathname === "/health") {
      return _jsonOk({
        status: "ok",
        version: "13.0",
        node: "cf-lb",
        t1Pool: T1_NODES.map((n) => ({
          id: n.id,
          errors: health.errCount(n.id),
          inFlight: health.inFlight(n.id),
          stressed: health.isStressed(n.id),
          failing: health.isFailing(n.id),
          emaMs: Math.round(health.emaMs(n.id)),
          score: Math.round(health.nodeScore(n.id)),
          samples: health.perfMap.get(n.id)?.sampleCount ?? 0,
          capacity:
            n.concurrencyLimit != null
              ? `${health.inFlight(n.id)}/${n.concurrencyLimit}`
              : "unlimited",
        })),
        t2Pool: T2_NODES.map((n) => ({
          id: n.id,
          errors: health.errCount(n.id),
          emaMs: Math.round(health.emaMs(n.id)),
          score: Math.round(health.nodeScore(n.id)),
        })),
        settings: {
          t1TimeoutMs: SETTINGS.t1TimeoutMs,
          t2TimeoutMs: SETTINGS.t2TimeoutMs,
          maxWallTimeMs: SETTINGS.maxWallTimeMs,
          posterEmbedTimeoutMs: SETTINGS.posterEmbedTimeoutMs,
        },
      });
    }

    // ── /hub-test ──────────────────────────────────────────────────────────
    if (url.pathname === "/hub-test") {
      const allNodes = [...T1_NODES, ...T2_NODES];
      const liveHealth = await Promise.all(
        allNodes.map(async (n) => ({
          id: n.id,
          health: await fetchNodeHealth(n.baseUrl),
          emaMs: Math.round(health.emaMs(n.id)),
          score: Math.round(health.nodeScore(n.id)),
          errors: health.errCount(n.id),
          inFlight: health.inFlight(n.id),
          samples: health.perfMap.get(n.id)?.sampleCount ?? 0,
        })),
      );
      const lastUpdate = getLastDashboardUpdate();
      return _jsonOk({
        discordConfigured: !!env.DISCORD_WEBHOOK_URL,
        lastDiscordUpdate: lastUpdate
          ? new Date(lastUpdate).toISOString()
          : null,
        t1Pool: T1_NODES.map((n) => ({
          id: n.id,
          errors: health.errCount(n.id),
          inFlight: health.inFlight(n.id),
          emaMs: Math.round(health.emaMs(n.id)),
          score: Math.round(health.nodeScore(n.id)),
          concurrencyLimit: n.concurrencyLimit,
        })),
        t2Pool: T2_NODES.map((n) => ({
          id: n.id,
          errors: health.errCount(n.id),
        })),
        liveHealth,
      });
    }

    // ── Main rasterization ─────────────────────────────────────────────────
    if (request.method !== "POST" && request.method !== "GET")
      return _jsonError(405, "Method not allowed");

    const svgUrl = request.headers.get("X-SVG-Url") || null;
    const colo = request.headers.get("X-CF-Colo") || request.cf?.colo || null;
    const fallbackImageUrl =
      request.headers.get("X-Fallback-Image-Url") || null;
    const posterUrl = request.headers.get("X-Poster-Url") || null;
    const inputType = request.headers.get("X-Input-Type") || "";
    const rawFormat = (
      request.headers.get("X-Format") ||
      url.searchParams.get("format") ||
      ""
    ).toLowerCase();
    const format = ["jpg", "jpeg", "webp"].includes(rawFormat)
      ? rawFormat
      : "png";

    let svgText;
    if (request.method === "POST") {
      svgText = await request.text();
      if (!svgText?.trim()) return _jsonError(400, "Empty SVG body");
    } else {
      const targetUrl = url.searchParams.get("url");
      if (!targetUrl) return _jsonError(400, "Missing ?url= parameter");
      try {
        const r = await fetch(targetUrl, {
          headers: { "User-Agent": "SpicyDevs-LB/12.0" },
        });
        if (!r.ok) return _jsonError(502, `SVG fetch failed: ${r.status}`);
        svgText = await r.text();
      } catch (e) {
        return _jsonError(502, `SVG fetch error: ${e?.message}`);
      }
    }

    return distributedRender({
      svgText,
      svgUrl,
      format,
      colo,
      fallbackImageUrl,
      posterUrl,
      inputType,
      env,
      t1Nodes: T1_NODES,
      t2Nodes: T2_NODES,
      settings: SETTINGS,
      health,
      log: _log,
    });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(updateDashboard(env, T1_NODES, T2_NODES, health, _log));
  },
};
