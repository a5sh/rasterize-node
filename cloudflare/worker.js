// cloudflare/worker.js — v14
//
// PURE LOAD BALANCER — No WASM, No Puppeteer
//
// Thin entry point wiring together cloudflare/lib/*:
//   nodeRegistry.js  — T1/T2 node views + settings, derived from assets/nodes.config.js
//   health.js        — per-isolate node health/error/perf state + KV fleet-snapshot bridge
//   geoRouting.js     — CF colo → region mapping, geo+score node ordering
//   nodeAttempt.js    — single-node raster attempt (URL-payload / POST, gzip)
//   embedding.js      — single-poster embed (CF-cache-backed) + outcome analytics
//   metricsWriter.js  — RASTER_METRICS Analytics Engine write helpers
//   raceDispatch.js   — the full distributed-render orchestration
//   fleetSync.js      — 15-min cron: AE stats → KV fleet snapshot + Discord dashboard + alerts
//   dashboard.js      — snapshot-driven Discord fleet dashboard + health-check CORS proxy
//
// Worker A builds SVG (icons expanded, poster as href URL) and sends to Worker B.
// Worker B fetches the poster image ONCE, embeds it, then distributes to nodes.
//
// Header contract (Worker A → Worker B):
//   X-Poster-Url          poster image URL → Worker B embeds once
//   X-SVG-Url             canonical .svg URL (wsrv / Vercel URL-payload path)
//   X-SVG-Encoding        optional 'gzip' — the POST body is gzip-compressed
//                         SVG. Stream-decompressed with DecompressionStream
//                         (Web API, workerd runtime); the CF edge's brotli/
//                         zstd is for client responses only, the in-worker
//                         stream codecs stay gzip/deflate.
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
import { createHealthState, createKvFleetBridge } from "./lib/health.js";
import { distributedRender } from "./lib/raceDispatch.js";
import { decompressGzipStream } from "./lib/nodeAttempt.js";
import {
  fetchNodeHealth,
  getLastDashboardUpdate,
} from "./lib/dashboard.js";
import { runFleetSync } from "./lib/fleetSync.js";
import { BRAND } from "./lib/embedBrand.js";

// ── Node-error relay rate limiter ─────────────────────────────────────────────
// Mirrors the nodes' own report limiter: at most MAX posts per window with a
// minimum gap — a node crash loop (or junk traffic) can't spray the webhook.

const NODE_ERR_WINDOW_MS = 5 * 60_000;
const NODE_ERR_BURST_MAX = 3;
const NODE_ERR_MIN_GAP_MS = 10_000;

let _relayCount = 0;
let _relayWindowEnd = 0;
let _relayLastPost = 0;

function _canRelayError() {
  const now = Date.now();
  if (now > _relayWindowEnd) {
    _relayCount = 0;
    _relayWindowEnd = now + NODE_ERR_WINDOW_MS;
  }
  if (_relayCount >= NODE_ERR_BURST_MAX) return false;
  if (now - _relayLastPost < NODE_ERR_MIN_GAP_MS) return false;
  return true;
}

async function relayNodeError(env, log, { node, title, message, ts }) {
  if (!env.DISCORD_WEBHOOK_URL || !_canRelayError()) return;
  _relayCount++;
  _relayLastPost = Date.now();
  log("info", "fleet_error_relay", { node, title });
  try {
    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "Posterium Alerts",
        avatar_url: BRAND.appIcon,
        embeds: [
          {
            title: `🚨 ${title}`,
            description: message?.slice(0, 2000) || "No details",
            color: 0xf87171,
            thumbnail: { url: BRAND.appIcon },
            fields: [{ name: "Node", value: node, inline: true }],
            footer: { text: `node report · ${node}` },
            timestamp: new Date(ts || Date.now()).toISOString(),
          },
        ],
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // fire-and-forget — never propagate
  }
}

// ── Structured logger ──────────────────────────────────────────────────────────

function _log(level, event, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    lb: "cf-v14",
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

// ── /proxy allowlist — the only hostnames the browser bridge may fetch ──────
// Mirrors rasterise/assets/nodes.config.js (the plain-HTTP fleet nodes).
// Kept in sync manually: adding a node to the config without adding it here
// just means the test page routes that node through /proxy with 403.
const PROXY_ALLOWED_HOSTS = new Set([
  "node-3.midas.host",
  "de20.spaceify.eu",
  "dono-01.danbot.host",
  "fr1.spaceify.eu",
]);

const health = createHealthState({
  errWindowMs: SETTINGS.errWindowMs,
  stressThreshold: SETTINGS.stressThreshold,
  failingThreshold: SETTINGS.failingThreshold,
});
const fleetBridge = createKvFleetBridge();

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
        version: "14.0",
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
      const lastUpdate = await getLastDashboardUpdate(env);
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

    // ── /report — node status/error beacon ────────────────────────────────────
    // core/serverlessReporter.js and vps|render discord.js POST here
    // (CF_REPORT_URL). 'online'/'metrics' reports are buffered to DASHBOARD_KV
    // ("fleet:heartbeat:<node>") and merged into the fleet snapshot by the
    // 15-minute cron in fleetSync.js; 'error'/'offline' reports are relayed
    // into the fleet Discord webhook right away (rate-limited below) and are
    // NOT written to the heartbeat buffer.
    if (request.method === "POST" && url.pathname === "/report") {
      try {
        const body = await request.json().catch(() => null);
        if (!body?.node) return _jsonError(400, "missing node");
        if (body.type === "error") {
          await relayNodeError(env, _log, {
            node: body.node,
            title: body.title || "Node reported an error",
            message: body.message || "",
            ts: body.ts || Date.now(),
          });
          return _jsonOk({ ok: true, relayed: true });
        }
        if (body.type === "offline") {
          await relayNodeError(env, _log, {
            node: body.node,
            title: body.reason ? `Node offline — ${body.reason}` : "Node offline",
            message: body.message || "",
            ts: body.ts || Date.now(),
          });
          return _jsonOk({ ok: true, relayed: true });
        }
        if (body.type !== "metrics" && body.type !== "online")
          return _jsonError(400, "unknown report type");
        await env.DASHBOARD_KV.put(
          `fleet:heartbeat:${body.node}`,
          JSON.stringify({ at: Date.now(), ...body }),
        );
        return _jsonOk({ ok: true });
      } catch (e) {
        return _jsonError(502, e?.message || "report failed");
      }
    }

    // ── /manual — debug: force a full fleet sync (AE analytics + health
    //    polls + heartbeat collection + Discord dashboard update) outside the
    //    15-min cron, ignoring the hourly/dashboard cooldowns. Same code path
    //    as scheduled(), via runFleetSync(force:true).
    if (url.pathname === "/manual") {
      if (request.method !== "GET" && request.method !== "POST")
        return _jsonError(405, "Method not allowed");
      try {
        await runFleetSync(env, _log, {
          t1Nodes: T1_NODES,
          t2Nodes: T2_NODES,
          force: true,
        });
        return _jsonOk({ ok: true, at: new Date().toISOString() });
      } catch (e) {
        return _jsonError(
          502,
          e?.message?.slice(0, 200) || "fleet sync failed",
        );
      }
    }

    // ── /proxy — browser bridge for plain-HTTP nodes ─────────────────────────
    // The admin test page (/admin/test) benchmarks every node directly from
    // the browser, but midas/germany/danbot/france listen on plain HTTP and
    // browsers refuse mixed-content fetches. This is NOT an open proxy: only
    // the four fleet node hostnames may be fetched, GET only, and the
    // upstream response is streamed back with CORS so the page can read it.
    if (url.pathname === "/proxy") {
      if (request.method !== "GET")
        return _jsonError(405, "Method not allowed");
      const target = url.searchParams.get("url");
      if (!target) return _jsonError(400, "Missing ?url= parameter");
      let upstream;
      try {
        upstream = new URL(target);
      } catch {
        return _jsonError(400, "Invalid ?url= parameter");
      }
      if (!["http:", "https:"].includes(upstream.protocol))
        return _jsonError(400, "Unsupported protocol");
      if (!PROXY_ALLOWED_HOSTS.has(upstream.hostname.toLowerCase()))
        return _jsonError(403, "Disallowed proxy host");
      try {
        const r = await fetch(upstream, {
          headers: { "User-Agent": "SpicyDevs-LB/14.0" },
          redirect: "manual",
          signal: AbortSignal.timeout(12_000),
        });
        const headers = new Headers(r.headers);
        headers.set("Access-Control-Allow-Origin", "*");
        return new Response(r.body, { status: r.status, headers });
      } catch (e) {
        return _jsonError(502, `Proxy error: ${e?.message || "fetch failed"}`);
      }
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
      // Worker A gzips the SVG uplink (X-SVG-Encoding: gzip) — the body is
      // piped through DecompressionStream as a stream, no full-buffer step.
      const encoding = request.headers.get("X-SVG-Encoding");
      if (encoding === "gzip") {
        try {
          svgText = await decompressGzipStream(request.body);
        } catch (e) {
          return _jsonError(400, `Gzip decode failed: ${e?.message}`);
        }
      } else if (encoding && encoding !== "identity") {
        return _jsonError(415, `Unsupported X-SVG-Encoding: ${encoding}`);
      } else {
        svgText = await request.text();
      }
      if (!svgText?.trim()) return _jsonError(400, "Empty SVG body");
      // Reject non-SVG bodies up front: garbage input used to burn the whole
      // T1/T2 chain (every node fails on an invalid document → 502 after
      // up to 10 outbound attempts per request). Cheap shape check only —
      // full validation is the nodes' job.
      if (
        svgText.length < 50 ||
        !/<\s*svg[\s>]/i.test(svgText) ||
        !/<\/svg\s*>/i.test(svgText)
      )
        return _jsonError(400, "Body does not look like an SVG");
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
      ctx,
      t1Nodes: T1_NODES,
      t2Nodes: T2_NODES,
      settings: SETTINGS,
      health,
      fleetBridge,
      log: _log,
    });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      runFleetSync(env, _log, { t1Nodes: T1_NODES, t2Nodes: T2_NODES }),
    );
  },
};
