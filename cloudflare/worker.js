// cloudflare/worker.js
//
// CHANGES v7
// ─────────────────────────────────────────────────────────────────────────────
// • Adds /report endpoint — receives metrics POSTs from render/vps nodes.
// • Adds scheduled() handler — fires every 5 min via cron trigger.
// • Discord is CENTRALISED here. render/discord.js and vps/discord.js are thin
//   reporters that POST to /report instead of hitting Discord directly.
//
// FREE TIER KV STRATEGY
// ─────────────────────────────────────────────────────────────────────────────
// The free tier allows only 1,000 KV writes and 1,000 KV list ops per day.
// 5 nodes × every 5 min = 1,440 node-metric writes/day alone — blows the limit.
//
// Solution: node metrics live in module-level memory (Map), NOT KV.
//   • KV is used ONLY to persist the Discord message ID across isolate restarts
//     (≈ 1 write per week when the message is created or re-created).
//   • Discord update rate-limiting uses a module-level timestamp, accepted to be
//     per-isolate (Discord's own webhook rate limit is the effective backstop).
//
// KV usage at steady state:
//   Reads:  ~288/day (msgId read on each cron fire)         ✅ < 100,000
//   Writes: ~0–1/day (only when Discord msg is re-created)  ✅ < 1,000
//   List:   0                                               ✅ < 1,000
//
// CPU time per invocation (free tier limit: 10ms):
//   Health fetches are async I/O — do not consume CPU time.
//   Embed string-building is < 2ms CPU. ✅

import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import fontBuffer from "../core/NotoSans-Subset.ttf";
import { applyFauxBold } from "../core/fauxBold.js";
import {
  expandIconPlaceholder,
  warmIconCache,
  iconCacheStatus,
} from "../core/iconCache.js";
import puppeteer from "@cloudflare/puppeteer";

warmIconCache();

// ── WASM init ─────────────────────────────────────────────────────────────────

let wasmReady = false;
let wasmPromise = null;

function ensureWasm() {
  if (wasmReady) return Promise.resolve();
  if (wasmPromise) return wasmPromise;
  wasmPromise = initWasm(resvgWasm)
    .then(() => {
      wasmReady = true;
    })
    .catch((e) => {
      wasmPromise = null;
      throw e;
    });
  return wasmPromise;
}

// ── resvg options ─────────────────────────────────────────────────────────────

const RESVG_OPTS = {
  fitTo: { mode: "original" },
  font: {
    loadSystemFonts: false,
    defaultFontFamily: "Noto Sans",
    sansSerifFamily: "Noto Sans",
    serifFamily: "Noto Sans",
    monospaceFamily: "Noto Sans",
    fontBuffers: [new Uint8Array(fontBuffer)],
  },
  imageRendering: 1,
};

// ── Proxy allowlist ───────────────────────────────────────────────────────────

const PROXY_ALLOWLIST = [
  "http://fr1.spaceify.eu:25980",
  "http://de20.spaceify.eu:26100",
  "http://node-3.midas.host:25108",
];

// ══════════════════════════════════════════════════════════════════════════════
// ── IN-ISOLATE FLEET STATE (no KV — see free tier strategy above) ─────────────
// ══════════════════════════════════════════════════════════════════════════════
//
// Cloudflare Workers run in isolates that are reused across requests to the
// same Worker instance. Module-level state persists for the isolate's lifetime
// (typically minutes to hours), which is more than adequate for a 5-min report
// cadence. On a cold isolate the state is empty; the next cron or /report call
// repopulates it within seconds.

// Map<nodeId, { node, type, ts, stats, snapshot, lastError }>
const _nodeMetrics = new Map();

// Module-level rate-limiter for Discord updates (per-isolate).
// Multiple concurrent isolates may each update Discord, but Discord's own
// webhook rate limit (5 PATCH/30s per message) is the effective ceiling.
let _lastDiscordUpdate = 0;
const DISCORD_MIN_INTERVAL_MS = 90_000; // 90 seconds

// ── Main handler ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return jsonOk({
        status: "ok",
        version: "7.0",
        node: "cloudflare",
        wasmReady,
        queueDepth: 0,
        iconCache: iconCacheStatus(),
        fleetNodes: _nodeMetrics.size,
      });
    }

    if (url.pathname === "/report") {
      return handleReport(request, env, ctx);
    }

    if (url.pathname === "/ss") {
      return handleScreenshot(request, env);
    }

    if (url.pathname === "/proxy") {
      return handleProxy(request);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, X-Format, X-SVG-Encoding",
        },
      });
    }

    // ── Rasterisation ────────────────────────────────────────────────────

    try {
      await ensureWasm();
    } catch (e) {
      return jsonError(503, `WASM init failed: ${e.message}`);
    }

    const formatHeader = request.headers.get("X-Format") || "";
    const formatParam = url.searchParams.get("format") || "";
    const format =
      ["png", "jpg", "jpeg", "webp"].find(
        (f) => f === (formatHeader || formatParam).toLowerCase(),
      ) || "png";

    let svgText;

    if (request.method === "POST") {
      const ct = request.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        let payload;
        try {
          payload = await request.json();
        } catch {
          return jsonError(400, "Invalid JSON");
        }
        if (!payload?.svgText) return jsonError(400, "Expected { svgText }");
        svgText = payload.svgText;
      } else {
        svgText = await request.text();
        if (!svgText?.trim()) return jsonError(400, "Empty body");
      }
    } else if (request.method === "GET") {
      const targetUrl = url.searchParams.get("url");
      if (!targetUrl) return jsonError(400, "Missing ?url= parameter");
      try {
        const r = await fetch(targetUrl, {
          headers: { "User-Agent": "SpicyDevs-Rasterizer/7.0" },
        });
        if (!r.ok) return jsonError(502, `SVG fetch failed: ${r.status}`);
        svgText = await r.text();
      } catch (e) {
        return jsonError(502, `SVG fetch error: ${e.message}`);
      }
    } else {
      return jsonError(405, "Method not allowed");
    }

    try {
      const withIcons = await expandIconPlaceholder(svgText);
      const embedded = await embedExternalImages(withIcons);
      const processed = applyFauxBold(embedded);
      const resvg = new Resvg(processed, RESVG_OPTS);
      const rendered = resvg.render();

      let imageBuffer, mimeType;

      if (format === "jpg" || format === "jpeg") {
        imageBuffer =
          typeof rendered.asJpeg === "function"
            ? rendered.asJpeg(85)
            : rendered.asPng();
        mimeType =
          typeof rendered.asJpeg === "function" ? "image/jpeg" : "image/png";
      } else if (format === "webp") {
        imageBuffer =
          typeof rendered.asWebp === "function"
            ? rendered.asWebp(85)
            : rendered.asPng();
        mimeType =
          typeof rendered.asWebp === "function" ? "image/webp" : "image/png";
      } else {
        imageBuffer = rendered.asPng();
        mimeType = "image/png";
      }

      const response = new Response(imageBuffer, {
        status: 200,
        headers: {
          "Content-Type": mimeType,
          "Cache-Control": "public, max-age=86400",
          "Access-Control-Allow-Origin": "*",
          "X-Queue-Depth": "0",
          "X-Node": "cloudflare",
        },
      });

      if (request.method === "GET") {
        ctx.waitUntil(caches.default.put(request, response.clone()));
      }

      return response;
    } catch (e) {
      return jsonError(500, e instanceof Error ? e.message : String(e));
    }
  },

  // ── Cron trigger ─────────────────────────────────────────────────────────
  // Fires every 5 minutes. Forces a Discord embed refresh regardless of the
  // in-isolate rate-limit, ensuring the embed stays current even when no nodes
  // happen to POST a /report in a given window (e.g. after a cold isolate start).
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(updateDashboard(env, true));
  },
};

// ── JSON helpers ──────────────────────────────────────────────────────────────

function jsonOk(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ── External image embedding ──────────────────────────────────────────────────

async function embedExternalImages(svgText) {
  const matches = [...svgText.matchAll(/href="(https?:\/\/[^"]+)"/g)];
  if (matches.length === 0) return svgText;

  const uniqueUrls = [...new Set(matches.map((m) => m[1]))];

  const replacements = await Promise.all(
    uniqueUrls.map(async (url) => {
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": "SpicyDevs-Rasterizer/7.0" },
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) return { url, dataUri: null };

        const buf = await res.arrayBuffer();
        const ct = res.headers.get("content-type") || "image/jpeg";
        const bytes = new Uint8Array(buf);
        const CHUNK = 0x8000;
        let binary = "";
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode.apply(
            null,
            bytes.subarray(i, i + CHUNK),
          );
        }
        return { url, dataUri: `data:${ct};base64,${btoa(binary)}` };
      } catch {
        return { url, dataUri: null };
      }
    }),
  );

  for (const { url, dataUri } of replacements) {
    if (dataUri)
      svgText = svgText.split(`href="${url}"`).join(`href="${dataUri}"`);
  }
  return svgText;
}

// ── /proxy ────────────────────────────────────────────────────────────────────

async function handleProxy(request) {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");

  if (!targetUrl) return jsonError(400, "Missing ?url= parameter");

  const allowed = PROXY_ALLOWLIST.some((prefix) =>
    targetUrl.startsWith(prefix),
  );
  if (!allowed)
    return jsonError(403, `Proxy target not in allowlist: ${targetUrl}`);

  const proxyHeaders = new Headers();
  for (const key of ["content-type", "x-format", "x-svg-encoding"]) {
    const val = request.headers.get(key);
    if (val) proxyHeaders.set(key, val);
  }
  proxyHeaders.set("User-Agent", "SpicyDevs-Proxy/1.0");

  const init = { method: request.method, headers: proxyHeaders };
  if (request.method === "POST") {
    init.body = await request.arrayBuffer();
  }

  let upstream;
  try {
    upstream = await fetch(targetUrl, init);
  } catch (e) {
    return jsonError(502, `Proxy fetch failed: ${e.message}`);
  }

  const respHeaders = new Headers(upstream.headers);
  respHeaders.set("Access-Control-Allow-Origin", "*");
  respHeaders.set("X-Proxied-Via", "cf-worker");
  respHeaders.set("X-Proxy-Target", targetUrl);

  return new Response(upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  });
}

// ── /ss ───────────────────────────────────────────────────────────────────────

async function handleScreenshot(request, env) {
  const { searchParams } = new URL(request.url);
  const targetUrl = searchParams.get("url");
  if (!targetUrl) return jsonError(400, "Missing ?url= parameter");

  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
    if (!["http:", "https:"].includes(parsedUrl.protocol))
      throw new Error("bad protocol");
  } catch {
    return jsonError(400, "Invalid URL — must be http or https");
  }

  const width = Math.min(
    Math.max(parseInt(searchParams.get("width") || "500", 10), 100),
    3840,
  );
  const height = Math.min(
    Math.max(parseInt(searchParams.get("height") || "750", 10), 100),
    2160,
  );
  const fullPage = searchParams.get("full") === "1";
  const format = searchParams.get("format") === "jpeg" ? "jpeg" : "png";
  const quality = Math.min(
    Math.max(parseInt(searchParams.get("quality") || "85", 10), 1),
    100,
  );
  const waitMs = Math.min(
    Math.max(parseInt(searchParams.get("wait") || "0", 10), 0),
    10_000,
  );

  let browser;
  try {
    browser = await puppeteer.launch(env.MYBROWSER);
    const page = await browser.newPage();
    await page.setViewport({ width, height });

    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const blocked = [
        "doubleclick.net",
        "googlesyndication.com",
        "adservice.google.com",
        "google-analytics.com",
      ];
      if (
        blocked.some((h) => req.url().includes(h)) ||
        ["media", "websocket", "manifest"].includes(req.resourceType())
      ) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(parsedUrl.toString(), {
      waitUntil: "load",
      timeout: 20_000,
    });
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

    const opts = {
      type: format,
      ...(format === "jpeg" ? { quality } : {}),
      ...(fullPage
        ? { fullPage: true }
        : { clip: { x: 0, y: 0, width, height } }),
    };
    const imageBuffer = await page.screenshot(opts);

    return new Response(imageBuffer, {
      status: 200,
      headers: {
        "Content-Type": format === "jpeg" ? "image/jpeg" : "image/png",
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
        "X-Screenshot-URL": parsedUrl.toString(),
      },
    });
  } catch (e) {
    return jsonError(500, e instanceof Error ? e.message : String(e));
  } finally {
    if (browser) await browser.close();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── DISCORD FLEET HUB ─────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// ── /report handler ───────────────────────────────────────────────────────────

async function handleReport(request, env, ctx) {
  if (request.method !== "POST") return jsonError(405, "POST only");

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Invalid JSON");
  }

  const { type, node, ts, stats, snapshot, title, description } = body;
  if (!node || !type) return jsonError(400, "Missing node or type");

  // Store in module-level memory — zero KV operations.
  // Keyed by node name so successive reports from the same node overwrite.
  _nodeMetrics.set(node, {
    node,
    type,
    ts: ts || Date.now(),
    stats: stats || null,
    snapshot: snapshot || null,
    lastError: stats?.lastError || null,
  });

  // Force Discord update for errors/offline; rate-limit routine reports.
  const force = type === "error" || type === "offline";
  ctx.waitUntil(updateDashboard(env, force));

  return jsonOk({ received: true, type, node });
}

// ── Node registry ─────────────────────────────────────────────────────────────

function getNodes(env) {
  const nodes = [];
  const add = (id, name, url) => {
    if (url) nodes.push({ id, name, url });
  };
  add("vercel-usw", "Vercel USW", env.VERCEL_NODE_URL);
  add("netlify", "Netlify Ohio", env.NETLIFY_NODE_URL);
  add("render", "Render", env.RENDER_NODE_URL);
  add("vps-1", "VPS 1", env.VPS1_NODE_URL);
  add("vps-2", "VPS 2", env.VPS2_NODE_URL);
  add("vps-3", "VPS 3", env.VPS3_NODE_URL);
  return nodes;
}

// ── Health polling ────────────────────────────────────────────────────────────

async function fetchNodeHealth(url) {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/health`, {
      headers: { "User-Agent": "SpicyDevs-Hub/7.0" },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return { reachable: false, httpStatus: res.status };
    return { reachable: true, ...(await res.json()) };
  } catch (e) {
    return { reachable: false, error: e.message };
  }
}

// ── KV helpers (message ID only) ─────────────────────────────────────────────
// KV is touched exclusively for the Discord dashboard message ID.
// Expected: ~0 writes/day at steady state, ~1 read per cron fire (288/day).

async function getMsgId(env) {
  if (!env.DASHBOARD_KV) return null;
  try {
    return await env.DASHBOARD_KV.get("cf:discord:msgId");
  } catch {
    return null;
  }
}

async function setMsgId(env, id) {
  if (!env.DASHBOARD_KV) return;
  await env.DASHBOARD_KV.put("cf:discord:msgId", id).catch(() => {});
}

async function clearMsgId(env) {
  if (!env.DASHBOARD_KV) return;
  await env.DASHBOARD_KV.delete("cf:discord:msgId").catch(() => {});
}

// ── Embed construction ────────────────────────────────────────────────────────

function fmtUptime(s) {
  if (!s) return "—";
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtRelTs(tsMs) {
  return tsMs ? `<t:${Math.floor(tsMs / 1000)}:R>` : "never";
}

function statusEmoji(health) {
  if (!health.reachable || health.status === "offline") return "🔴";
  if (health.status === "degraded") return "🟠";
  return "🟢";
}

function buildNodeFieldValue(health, stored) {
  const lines = [];

  if (!health.reachable) {
    const err = health.error
      ? health.error.slice(0, 80)
      : `HTTP ${health.httpStatus || "???"}`;
    lines.push(`❌ **Unreachable** — \`${err}\``);
    if (stored?.ts) lines.push(`Last report: ${fmtRelTs(stored.ts)}`);
    return lines.join("\n");
  }

  // Status / version / uptime
  const row1 = [
    health.version ? `v${health.version}` : null,
    health.status ? health.status : null,
    health.uptime ? `up ${fmtUptime(health.uptime)}` : null,
  ].filter(Boolean);
  if (row1.length) lines.push(row1.join(" · "));

  // Worker pool (long-lived nodes only)
  if (health.activeJobs !== undefined) {
    const row2 = [];
    if (health.workerCount) row2.push(`${health.workerCount} workers`);
    row2.push(`${health.activeJobs} active`);
    if (health.queuedJobs) row2.push(`${health.queuedJobs} queued`);
    if (health.pendingRespawns)
      row2.push(`⚠️ ${health.pendingRespawns} respawning`);
    lines.push(row2.join(" · "));
  }

  // Font + icon cache
  const cap = [];
  if (health.fontReady !== undefined)
    cap.push(health.fontReady ? "Font ✅" : "Font ❌");
  if (health.iconCache?.loaded)
    cap.push(`Icons: ${health.iconCache.iconCount}`);
  else if (health.iconCache?.lastError) cap.push("Icons ❌");
  if (cap.length) lines.push(cap.join(" · "));

  // Metrics snapshot from /report (render/vps; not available for serverless nodes)
  const snap = stored?.snapshot;
  if (snap) {
    if (snap.jobDuration?.n > 0) {
      const d = snap.jobDuration;
      lines.push(
        `Latency — p50 \`${d.p50}ms\` · p95 \`${d.p95}ms\` · p99 \`${d.p99}ms\` · max \`${d.max}ms\``,
      );
    }
    if (snap.cpu?.n > 0) {
      lines.push(
        `CPU avg \`${snap.cpu.avg}%\` p95 \`${snap.cpu.p95}%\`` +
          (snap.mem?.n > 0
            ? ` · Mem avg \`${snap.mem.avg}%\` p95 \`${snap.mem.p95}%\``
            : ""),
      );
    }
    if (snap.requests !== undefined) {
      const r = [`Req: **${snap.requests}**`, `Err: **${snap.errors}**`];
      if (snap.wsrvFallbacks) r.push(`wsrv: ${snap.wsrvFallbacks}`);
      if (snap.resvgFails) r.push(`resvg fails: ${snap.resvgFails}`);
      lines.push(r.join(" · ") + " _(last 5m)_");
    }
    if (snap.queueDepth?.max > 0) {
      lines.push(
        `Queue — avg \`${snap.queueDepth.avg}\` · p95 \`${snap.queueDepth.p95}\` · max \`${snap.queueDepth.max}\``,
      );
    }
  }

  // Last error
  const lastErr = stored?.lastError || stored?.stats?.lastError;
  if (lastErr?.message) {
    lines.push(
      `⚠️ Last err: \`${lastErr.message.slice(0, 100)}\` ${fmtRelTs(lastErr.ts)}`,
    );
  }

  // Staleness warning
  if (stored?.ts && Date.now() - stored.ts > 15 * 60_000) {
    lines.push(`_⏳ Metrics stale — last report ${fmtRelTs(stored.ts)}_`);
  }

  return lines.join("\n") || "_(no data)_";
}

async function buildFleetEmbed(env, nodes) {
  // Poll all external nodes in parallel — pure I/O, doesn't burn CPU budget
  const healthResults = await Promise.all(
    nodes.map((n) => fetchNodeHealth(n.url).then((h) => ({ ...n, health: h }))),
  );

  // CF self entry — internal state, no HTTP call
  const cfEntry = {
    id: "cloudflare",
    name: "Cloudflare Edge",
    health: {
      reachable: true,
      status: "online",
      version: "7.0",
      node: "cloudflare",
      wasmReady,
      iconCache: iconCacheStatus(),
    },
  };

  const allEntries = [cfEntry, ...healthResults];

  const online = allEntries.filter(
    (e) =>
      e.health.reachable && !["degraded", "offline"].includes(e.health.status),
  ).length;
  const degraded = allEntries.filter(
    (e) => e.health.reachable && e.health.status === "degraded",
  ).length;
  const offline = allEntries.filter(
    (e) => !e.health.reachable || e.health.status === "offline",
  ).length;

  const color = offline > 0 ? 0xe74c3c : degraded > 0 ? 0xe67e22 : 0x2ecc71;

  const fields = [
    { name: "🟢 Online", value: `\`${online}\``, inline: true },
    { name: "🟠 Degraded", value: `\`${degraded}\``, inline: true },
    { name: "🔴 Offline", value: `\`${offline}\``, inline: true },
    ...allEntries.map((e) => ({
      name: `${statusEmoji(e.health)} ${e.name}`,
      // Look up stored metrics by node id OR by the name the node reported itself as
      value: buildNodeFieldValue(
        e.health,
        _nodeMetrics.get(e.id) || _nodeMetrics.get(e.name) || null,
      ),
      inline: false,
    })),
  ];

  return {
    embeds: [
      {
        title: "🎯 Posterium Rasterizer Fleet",
        color,
        fields,
        footer: {
          text: `${allEntries.length} nodes · Hub: Cloudflare Edge · KV: msgId only`,
        },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

// ── Discord webhook ───────────────────────────────────────────────────────────

async function discordPost(url, payload) {
  try {
    const res = await fetch(`${url}?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error("[hub] Discord POST failed:", res.status);
      return null;
    }
    return res.json();
  } catch (e) {
    console.error("[hub] Discord POST error:", e.message);
    return null;
  }
}

async function discordPatch(url, msgId, payload) {
  try {
    const res = await fetch(`${url}/messages/${msgId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Dashboard update orchestrator ─────────────────────────────────────────────

async function updateDashboard(env, force = false) {
  const webhookUrl = env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;

  // Per-isolate rate-limit (force=true bypasses — used for cron + errors)
  if (!force && Date.now() - _lastDiscordUpdate < DISCORD_MIN_INTERVAL_MS)
    return;
  _lastDiscordUpdate = Date.now();

  const nodes = getNodes(env);
  let payload;
  try {
    payload = await buildFleetEmbed(env, nodes);
  } catch (e) {
    console.error("[hub] buildFleetEmbed error:", e.message);
    return;
  }

  // Single KV read to get the message ID — the only KV operation at steady state
  let msgId = await getMsgId(env);

  if (msgId) {
    const ok = await discordPatch(webhookUrl, msgId, payload);
    if (!ok) {
      console.warn("[hub] PATCH failed — message deleted? Creating new one.");
      await clearMsgId(env);
      msgId = null;
    }
  }

  if (!msgId) {
    const msg = await discordPost(webhookUrl, payload);
    if (msg?.id) {
      await setMsgId(env, msg.id); // only KV write in steady state
      console.log("[hub] Created dashboard message:", msg.id);
    }
  }
}
