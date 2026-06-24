// cloudflare/worker.js — v11
//
// PURE LOAD BALANCER — no WASM rendering
//
// ── Architecture ──────────────────────────────────────────────────────────────
//
// Worker A (posterium-backend) sends:
//   POST /
//     Body:                   SVG text (icons expanded, poster as href URL)
//     X-Poster-Url:           TMDB/fanart poster image URL → Worker B fetches
//                             & embeds ONCE (eliminates double-fetch bug)
//     X-SVG-Url:              canonical .svg URL (for wsrv / Vercel URL-payload)
//     X-CF-Colo:              requesting datacenter colo (geo routing)
//     X-Format:               png | jpg | webp
//     X-Fallback-Image-Url:   original TMDB poster URL for last-resort 302
//     X-Input-Type:           movie | tv | anime (analytics only)
//     X-Request-Id:           trace ID
//
// Worker B flow:
//   1. Fetch X-Poster-Url → embed as base64 in SVG (single fetch, ~200ms)
//   2. Geo-order T1 pool (skip over-capacity / failing nodes)
//   3. Try each T1 node sequentially:
//        - URL-payload (wsrv, Vercel): pass X-SVG-Url directly (no embedded body needed)
//        - Body nodes (Netlify, Spaceify, DanBot): POST fully-embedded SVG
//   4. First success → stream to caller with X-Raster-* health headers
//   5. All T1 fail → try T2 pool (france, render_eu) with longer timeout
//   6. T2 fail → 302 to X-Fallback-Image-Url (TMDB original)
//   7. No fallback URL → 502
//
// ── Analytics (RASTER_METRICS) ───────────────────────────────────────────────
//
// Per-attempt datapoint:
//   blob1  = node_id          e.g. 'midas', 'wsrv', 'danbot'
//   blob2  = format           'png' | 'jpg' | 'webp'
//   blob3  = input_type       'movie' | 'tv' | 'anime'
//   blob4  = colo             CF datacenter code
//   blob5  = outcome          'success' | 'failure'
//   blob6  = error_reason     timeout | http_NNN | throw | '' on success
//   blob7  = lane             't1' | 't2' | 'wsrv' | 'url_payload'
//   blob8  = was_winner       '1' | '0'
//   double1 = attempt_ms      wall time for this single node attempt
//   double2 = http_status     200 / 502 / 504 / 0
//   double3 = is_winner       1.0 | 0.0  (sum() = total wins per node)
//   double4 = inflight_count  snapshot at attempt start (concurrency indicator)
//   double5 = payload_kb      SVG payload size in KB
//
// Per-request summary (blob1 = 'req'):
//   double1 = total_wall_ms
//   double2 = attempts_made
//   double3 = 1  (for count)
//   double4 = poster_embed_ms
//   double5 = payload_kb

import puppeteer from "@cloudflare/puppeteer";
import NODE_CONFIG from "../assets/nodes.config.js";

// ── Structured logger ─────────────────────────────────────────────────────────

function _log(level, event, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    node: "cf-lb",
    ...meta,
  };
  if (level === "error") console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

// ── Node pool ──────────────────────────────────────────────────────────────────

const T1_NODES = NODE_CONFIG.nodes
  .filter((n) => n.features.inLbWorker)
  .sort((a, b) => (a.specs.tier ?? 99) - (b.specs.tier ?? 99))
  .map((n) => ({
    id: n.id,
    url: `${n.url}${n.features.apiPath ?? ""}`,
    lbRegion: n.lbRegion,
    concurrencyLimit: n.concurrencyLimit,
    cpuAlloc: n.cpuAlloc,
    useUrlPayload: n.features.useUrlPayload ?? false,
    acceptsGzip: n.features.acceptsCompression ?? false,
    supportsHealth: n.features.supportsHealthCheck ?? false,
    zones: n.zones ?? {},
  }));

const T2_NODES = NODE_CONFIG.nodes
  .filter((n) => n.features.isLbFallback)
  .map((n) => ({
    id: n.id,
    url: `${n.url}${n.features.apiPath ?? ""}`,
    lbRegion: n.lbRegion,
    concurrencyLimit: n.concurrencyLimit,
    useUrlPayload: false,
    acceptsGzip: n.features.acceptsCompression ?? false,
  }));

const {
  t1TimeoutMs = 5_000,
  t2TimeoutMs = 8_000,
  posterEmbedTimeoutMs = 6_000,
} = NODE_CONFIG.settings;

// ── Per-isolate health state ───────────────────────────────────────────────────

const _errMap = new Map(); // node id → { count, windowEnd }
const _inflightMap = new Map(); // node id → current in-flight count
const ERR_WINDOW = 60_000;
const { stressThreshold = 3, failingThreshold = 8 } = NODE_CONFIG.settings;

function _recordErr(id) {
  const now = Date.now();
  let e = _errMap.get(id) ?? { count: 0, windowEnd: now + ERR_WINDOW };
  if (now > e.windowEnd) e = { count: 0, windowEnd: now + ERR_WINDOW };
  e.count++;
  _errMap.set(id, e);
}
function _recordOk(id) {
  const e = _errMap.get(id);
  if (e) e.count = Math.max(0, e.count - 1);
}
function _errCount(id) {
  const e = _errMap.get(id);
  return !e || Date.now() > e.windowEnd ? 0 : e.count;
}
function _isStressed(id) {
  return _errCount(id) >= stressThreshold;
}
function _isFailing(id) {
  return _errCount(id) >= failingThreshold;
}
function _acqIF(id) {
  _inflightMap.set(id, (_inflightMap.get(id) ?? 0) + 1);
}
function _relIF(id) {
  _inflightMap.set(id, Math.max(0, (_inflightMap.get(id) ?? 0) - 1));
}
function _inFlight(id) {
  return _inflightMap.get(id) ?? 0;
}
function _atCapacity(n) {
  return n.concurrencyLimit !== null && _inFlight(n.id) >= n.concurrencyLimit;
}

// ── Geo region mapping ────────────────────────────────────────────────────────

const _COLO_REGION = (() => {
  const m = {};
  const zones = {
    NA: [
      "IAD",
      "EWR",
      "MIA",
      "ORD",
      "ATL",
      "BOS",
      "LAX",
      "SFO",
      "SEA",
      "DFW",
      "MSP",
      "PHX",
      "DEN",
      "PDX",
      "LAS",
      "SMF",
      "SLC",
      "OAK",
      "SJC",
      "DTW",
      "PHL",
      "CMH",
      "BUF",
      "CLE",
      "MSY",
      "PIT",
      "RDU",
      "STL",
      "OKC",
      "KCI",
      "OMA",
      "TUL",
      "YYZ",
      "YVR",
    ],
    EU: [
      "LHR",
      "CDG",
      "AMS",
      "DUB",
      "FRA",
      "ZRH",
      "ARN",
      "WAW",
      "FCO",
      "MAD",
      "BCN",
      "MUC",
      "DUS",
      "HAM",
      "BRU",
      "GVA",
      "CPH",
      "OSL",
      "HEL",
      "LIS",
      "VIE",
      "PRG",
      "BUD",
      "OTP",
      "SOF",
      "SKP",
      "BEG",
      "RIX",
      "VNO",
      "TLL",
      "MXP",
      "MAN",
      "EDI",
    ],
  };
  for (const [r, colos] of Object.entries(zones))
    for (const c of colos) m[c] = r;
  return m;
})();

function _geoOrderNodes(colo) {
  const req = (colo && _COLO_REGION[colo.toUpperCase()]) || "NA";
  const same = T1_NODES.filter((n) => n.lbRegion === req);
  const other = T1_NODES.filter((n) => n.lbRegion !== req);
  // Within each geo group: healthy first, stressed second, failing last; then by capacity
  const rank = (n) =>
    (_isFailing(n.id) ? 20 : _isStressed(n.id) ? 10 : 0) +
    (_atCapacity(n) ? 5 : 0);
  return [...same, ...other].sort((a, b) => rank(a) - rank(b));
}

// ── Gzip helper ────────────────────────────────────────────────────────────────

async function _gzip(text) {
  try {
    const ds = new CompressionStream("gzip");
    const w = ds.writable.getWriter();
    w.write(new TextEncoder().encode(text));
    w.close();
    return await new Response(ds.readable).arrayBuffer();
  } catch {
    return null;
  }
}

// ── Poster embedding (single fetch, Worker B side) ─────────────────────────────
//
// Worker A sends the poster as an href URL in the SVG. Worker B fetches it ONCE
// and replaces all occurrences with a base64 data URI before distributing to nodes.
// This fixes the double-fetch bug where both Worker A and each node independently
// fetched the same poster image.

async function embedPosterInSvg(svgText, posterUrl) {
  if (!posterUrl) return { svg: svgText, embedMs: 0, embedded: false };
  const t0 = Date.now();
  try {
    const res = await fetch(posterUrl, {
      signal: AbortSignal.timeout(posterEmbedTimeoutMs),
      headers: { "User-Agent": "SpicyDevs-LB/11.0", Accept: "image/*" },
      // CF edge cache — posters are CDN-cached already
      cf: { cacheTtl: 86400, cacheEverything: true },
    });
    if (!res.ok) {
      _log("warn", "poster_embed_http_err", {
        status: res.status,
        url: posterUrl.slice(0, 100),
      });
      return { svg: svgText, embedMs: Date.now() - t0, embedded: false };
    }
    const buf = await res.arrayBuffer();
    const ct = res.headers.get("content-type") || "image/jpeg";
    const b64 = _bufToB64(buf);
    const uri = `data:${ct};base64,${b64}`;
    // Replace the URL href with data URI — works for both quoted and unquoted
    const embedded = svgText.split(`href="${posterUrl}"`).join(`href="${uri}"`);
    return { svg: embedded, embedMs: Date.now() - t0, embedded: true };
  } catch (e) {
    _log("warn", "poster_embed_failed", {
      reason: e?.message,
      url: posterUrl.slice(0, 100),
    });
    return { svg: svgText, embedMs: Date.now() - t0, embedded: false };
  }
}

// ── Single node attempt ────────────────────────────────────────────────────────

async function _tryNode(node, svgText, svgUrl, format, signal) {
  _acqIF(node.id);
  try {
    let res;
    if (node.useUrlPayload && svgUrl) {
      // URL-payload path (wsrv.nl, Vercel washington)
      // These nodes fetch the SVG themselves — no embedded body needed
      let target;
      if (node.id === "wsrv") {
        // wsrv.nl needs the posterium backend URL (no_embed=1 version)
        const src = new URL(svgUrl);
        src.hostname = "posterium-backend.aayu5h.workers.dev";
        src.searchParams.delete("no_embed");
        const u = new URL("https://wsrv.nl/");
        u.searchParams.set("url", src.toString());
        u.searchParams.set(
          "output",
          format === "webp"
            ? "webp"
            : format === "jpg" || format === "jpeg"
              ? "jpeg"
              : "png",
        );
        u.searchParams.set("q", "100");
        target = u.toString();
      } else {
        // Vercel: GET ?url=[svgUrl]&format=[fmt]
        const u = new URL(node.url);
        u.searchParams.set("url", svgUrl);
        u.searchParams.set("format", format);
        target = u.toString();
      }
      res = await fetch(target, {
        method: "GET",
        headers: { "User-Agent": "SpicyDevs-LB/11.0" },
        signal,
      });
    } else {
      // Body-POST path: send fully-embedded SVG
      let body = svgText,
        ct = "image/svg+xml";
      const extraHeaders = {};
      if (node.acceptsGzip) {
        const gz = await _gzip(svgText);
        if (gz) {
          body = gz;
          ct = "application/octet-stream";
          extraHeaders["X-SVG-Encoding"] = "gzip";
        }
      }
      res = await fetch(node.url, {
        method: "POST",
        body,
        headers: {
          "Content-Type": ct,
          "X-Format": format,
          "User-Agent": "SpicyDevs-LB/11.0",
          ...extraHeaders,
        },
        signal,
      });
    }

    if (!res.ok) {
      _recordErr(node.id);
      return {
        ok: false,
        res: null,
        error: `http_${res.status}`,
        status: res.status,
      };
    }
    _recordOk(node.id);
    return { ok: true, res, error: "", status: res.status };
  } catch (e) {
    if (e?.name !== "AbortError") _recordErr(node.id);
    return {
      ok: false,
      res: null,
      error:
        e?.name === "AbortError"
          ? "timeout"
          : `throw:${e?.message?.slice(0, 60)}`,
      status: 0,
    };
  } finally {
    _relIF(node.id);
  }
}

// ── Analytics logging ─────────────────────────────────────────────────────────

function _logAttempt(
  env,
  {
    nodeId,
    format,
    inputType,
    colo,
    outcome,
    errorReason,
    lane,
    isWinner,
    attemptMs,
    httpStatus,
    inflightCount,
    payloadKb,
  },
) {
  try {
    env?.RASTER_METRICS?.writeDataPoint({
      blobs: [
        nodeId,
        format,
        inputType,
        colo,
        outcome,
        errorReason,
        lane,
        isWinner ? "1" : "0",
      ],
      doubles: [
        attemptMs,
        httpStatus,
        isWinner ? 1 : 0,
        inflightCount,
        payloadKb,
      ],
      indexes: [nodeId],
    });
  } catch (_) {}
}

function _logRequest(
  env,
  {
    format,
    inputType,
    colo,
    totalWallMs,
    attemptsMade,
    posterEmbedMs,
    payloadKb,
    outcome,
  },
) {
  try {
    env?.RASTER_METRICS?.writeDataPoint({
      blobs: ["req", format, inputType, colo, outcome, "", "wall", ""],
      doubles: [totalWallMs, attemptsMade, 1, posterEmbedMs, payloadKb],
      indexes: ["req"],
    });
  } catch (_) {}
}

// ── Main render dispatch ───────────────────────────────────────────────────────

async function _distributedRender(
  svgText,
  svgUrl,
  format,
  colo,
  fallbackImageUrl,
  posterUrl,
  inputType,
  env,
) {
  const tWall0 = Date.now();
  const payloadKb = Math.round(new Blob([svgText]).size / 1024);
  let attemptsMade = 0;

  // ── Step 1: Embed poster (single fetch) ────────────────────────────────────
  const {
    svg: embeddedSvg,
    embedMs,
    embedded,
  } = await embedPosterInSvg(svgText, posterUrl);

  _log("info", "render_start", {
    colo,
    format,
    inputType,
    payloadKb,
    posterEmbedMs: embedMs,
    posterEmbedded: embedded,
    svgUrlSet: !!svgUrl,
    fallbackUrlSet: !!fallbackImageUrl,
  });

  // ── Step 2: Try T1 nodes (geo-ordered) ────────────────────────────────────
  const ordered = _geoOrderNodes(colo);
  let winnerSource = null;

  for (const node of ordered) {
    attemptsMade++;
    const inflightCount = _inFlight(node.id);

    // Skip at-capacity nodes (but still try if it's the last one)
    if (_atCapacity(node) && ordered.indexOf(node) < ordered.length - 1) {
      _log("info", "t1_skip_capacity", {
        node: node.id,
        inflight: inflightCount,
        limit: node.concurrencyLimit,
      });
      _logAttempt(env, {
        nodeId: node.id,
        format,
        inputType,
        colo,
        outcome: "skipped",
        errorReason: "at_capacity",
        lane: "t1",
        isWinner: false,
        attemptMs: 0,
        httpStatus: 0,
        inflightCount,
        payloadKb,
      });
      continue;
    }

    _log("info", "t1_attempt", {
      node: node.id,
      attempt: attemptsMade,
      inflight: inflightCount,
      failing: _isFailing(node.id),
      stressed: _isStressed(node.id),
    });

    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), t1TimeoutMs);
    const t0 = Date.now();
    const { ok, res, error, status } = await _tryNode(
      node,
      embeddedSvg,
      svgUrl,
      format,
      ac.signal,
    ).finally(() => clearTimeout(tm));
    const attemptMs = Date.now() - t0;

    _logAttempt(env, {
      nodeId: node.id,
      format,
      inputType,
      colo,
      outcome: ok ? "success" : "failure",
      errorReason: error,
      lane: node.useUrlPayload ? "url_payload" : "t1",
      isWinner: ok,
      attemptMs,
      httpStatus: status,
      inflightCount,
      payloadKb,
    });

    if (ok) {
      winnerSource = node.id;
      _log("info", "t1_success", {
        node: node.id,
        attempt: attemptsMade,
        attemptMs,
      });
      _logRequest(env, {
        format,
        inputType,
        colo,
        totalWallMs: Date.now() - tWall0,
        attemptsMade,
        posterEmbedMs: embedMs,
        payloadKb,
        outcome: "success",
      });
      return _buildImageResp(
        res,
        node.id,
        attemptsMade,
        Date.now() - tWall0,
        embedMs,
      );
    }

    _log("warn", "t1_failed", {
      node: node.id,
      attempt: attemptsMade,
      error,
      attemptMs,
    });
  }

  // ── Step 3: Try T2 (extreme fallback) ────────────────────────────────────
  for (const node of T2_NODES) {
    attemptsMade++;
    _log("warn", "t2_attempt", { node: node.id, reason: "all_t1_failed" });

    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), t2TimeoutMs);
    const t0 = Date.now();
    const { ok, res, error, status } = await _tryNode(
      node,
      embeddedSvg,
      svgUrl,
      format,
      ac.signal,
    ).finally(() => clearTimeout(tm));
    const attemptMs = Date.now() - t0;

    _logAttempt(env, {
      nodeId: node.id,
      format,
      inputType,
      colo,
      outcome: ok ? "success" : "failure",
      errorReason: error,
      lane: "t2",
      isWinner: ok,
      attemptMs,
      httpStatus: status,
      inflightCount: 0,
      payloadKb,
    });

    if (ok) {
      _log("info", "t2_success", { node: node.id, attemptMs });
      _logRequest(env, {
        format,
        inputType,
        colo,
        totalWallMs: Date.now() - tWall0,
        attemptsMade,
        posterEmbedMs: embedMs,
        payloadKb,
        outcome: "success_t2",
      });
      return _buildImageResp(
        res,
        node.id,
        attemptsMade,
        Date.now() - tWall0,
        embedMs,
      );
    }

    _log("error", "t2_failed", { node: node.id, error, attemptMs });
  }

  // ── Step 4: Last resort — 302 to TMDB original ───────────────────────────
  _log("error", "chain_exhausted", {
    colo,
    format,
    attempts: attemptsMade,
    wallMs: Date.now() - tWall0,
  });
  _logRequest(env, {
    format,
    inputType,
    colo,
    totalWallMs: Date.now() - tWall0,
    attemptsMade,
    posterEmbedMs: embedMs,
    payloadKb,
    outcome: "failure",
  });

  if (fallbackImageUrl) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: fallbackImageUrl,
        "Access-Control-Allow-Origin": "*",
        "X-Raster-Source": "tmdb-fallback-redirect",
        "X-Failure-Reason": "all_nodes_exhausted",
        "X-Attempt-Count": String(attemptsMade),
        "Cache-Control": "no-store",
      },
    });
  }

  return new Response(
    JSON.stringify({
      error: "All rasterizers exhausted",
      attempts: attemptsMade,
    }),
    {
      status: 502,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}

// ── Image response builder ─────────────────────────────────────────────────────

function _buildImageResp(upstream, source, attemptCount, wallMs, embedMs) {
  const h = new Headers(upstream.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("X-Raster-Source", source);
  h.set("X-Attempt-Count", String(attemptCount));
  h.set("X-Wall-Ms", String(wallMs));
  h.set("X-Poster-Embed-Ms", String(embedMs));
  h.set("X-LB-Node", "cf-lb-v11");
  h.set("Cache-Control", "public, max-age=172800");
  // Expose headers so callers / CDNs can read them
  h.set(
    "Access-Control-Expose-Headers",
    "X-Raster-Source,X-Attempt-Count,X-Wall-Ms,X-Poster-Embed-Ms,X-LB-Node",
  );
  return new Response(upstream.body, { status: 200, headers: h });
}

// ── Fleet dashboard helpers ────────────────────────────────────────────────────

let _lastDiscordUpdate = 0;
const _nodeMetrics = new Map();
const DISCORD_MIN_INTERVAL_MS = 90_000;

function getNodes(env) {
  const vars = { env };
  return NODE_CONFIG.nodes
    .filter(
      (n) =>
        n.features.supportsHealthCheck ??
        n.features.inLbWorker ??
        n.features.isLbFallback,
    )
    .map((n) => ({
      id: n.id,
      name: n.label,
      url: n.url,
      region: n.specs.description || n.region,
      tier: n.specs.tier,
      cpuAlloc: n.cpuAlloc,
      concurrencyLimit: n.concurrencyLimit,
    }));
}

async function fetchNodeHealth(baseUrl) {
  try {
    const r = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(4_000),
      headers: { "User-Agent": "SpicyDevs-LB/11.0" },
    });
    return r.ok ? await r.json().catch(() => null) : null;
  } catch {
    return null;
  }
}

async function updateDashboard(env, isCron = false) {
  if (!env.DISCORD_WEBHOOK_URL) return;
  const now = Date.now();
  if (!isCron && now - _lastDiscordUpdate < DISCORD_MIN_INTERVAL_MS) return;
  _lastDiscordUpdate = now;

  const nodes = getNodes(env);
  const healthResults = await Promise.all(
    nodes.map((n) => fetchNodeHealth(n.url).then((h) => ({ ...n, health: h }))),
  );

  const t1Pool = T1_NODES.map((n) => ({
    id: n.id,
    errors: _errCount(n.id),
    inFlight: _inFlight(n.id),
    stressed: _isStressed(n.id),
    failing: _isFailing(n.id),
    cpuAlloc: n.cpuAlloc,
    concurrencyLimit: n.concurrencyLimit,
  }));

  function statusEmoji(h, t1) {
    if (!h) return "🔴";
    if (t1?.failing) return "🟠";
    if (t1?.stressed) return "🟡";
    return "🟢";
  }

  const fields = healthResults.map((n) => {
    const t1 = t1Pool.find((x) => x.id === n.id);
    const h = n.health;
    const lines = [
      `${statusEmoji(h, t1)} **${n.name}**`,
      h
        ? `⏱ Active: ${h.activeJobs ?? "?"} | Queue: ${h.queuedJobs ?? "?"}`
        : "❌ Offline",
      t1
        ? `Errors: ${t1.errors} | In-flight: ${t1.inFlight}/${t1.concurrencyLimit ?? "∞"} | CPU: ${n.cpuAlloc ?? "?"}%`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    return { name: "\u200B", value: lines, inline: true };
  });

  const payload = {
    username: "Posterium LB — v11",
    embeds: [
      {
        title: "🖼️ Raster Node Fleet Status",
        color: t1Pool.some((n) => n.failing)
          ? 0xf87171
          : t1Pool.some((n) => n.stressed)
            ? 0xfacc15
            : 0x4ade80,
        fields,
        footer: {
          text: `${isCron ? "Cron" : "Report"} · ${new Date().toISOString()}`,
        },
      },
    ],
  };

  try {
    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    _log("warn", "discord_webhook_failed", { reason: e?.message });
  }
}

// ── Misc handlers ─────────────────────────────────────────────────────────────

async function handleReport(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Invalid JSON");
  }
  const { node, type, snapshot } = body ?? {};
  if (!node) return jsonError(400, "Missing node");

  if (type === "metrics" && snapshot)
    _nodeMetrics.set(node, { ...snapshot, receivedAt: Date.now() });
  if (type === "online")
    _nodeMetrics.set(node, { online: true, receivedAt: Date.now() });

  ctx.waitUntil(updateDashboard(env, false));
  return jsonOk({ ok: true, node, type });
}

async function handleScreenshot(request, env) {
  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  if (!target) return jsonError(400, "Missing ?url=");
  if (!env.MYBROWSER) return jsonError(503, "Browser binding not configured");
  try {
    const browser = await puppeteer.launch(env.MYBROWSER);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.goto(target, { waitUntil: "networkidle0", timeout: 10_000 });
    const screenshot = await page.screenshot({ type: "png" });
    await browser.close();
    return new Response(screenshot, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e) {
    return jsonError(500, `Screenshot failed: ${e?.message}`);
  }
}

async function handleProxy(request) {
  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  if (!target) return jsonError(400, "Missing ?url=");
  const ALLOWLIST = NODE_CONFIG.nodes.map((n) => new URL(n.url).host);
  const tUrl = new URL(target);
  if (!ALLOWLIST.includes(tUrl.host))
    return jsonError(403, "URL not in allowlist");
  try {
    const res = await fetch(target, {
      headers: { "User-Agent": "SpicyDevs-LB/11.0" },
      signal: AbortSignal.timeout(8_000),
    });
    const h = new Headers(res.headers);
    h.set("Access-Control-Allow-Origin", "*");
    return new Response(res.body, { status: res.status, headers: h });
  } catch (e) {
    return jsonError(502, e?.message);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function _bufToB64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 32768)
    bin += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + 32768, bytes.length)),
    );
  return btoa(bin);
}

function jsonOk(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
function jsonError(status, msg) {
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

    // ── CORS preflight ──────────────────────────────────────────────────────
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

    // ── Health check ────────────────────────────────────────────────────────
    if (url.pathname === "/health") {
      return jsonOk({
        status: "ok",
        version: "11.0",
        node: "cf-lb",
        t1Pool: T1_NODES.map((n) => ({
          id: n.id,
          errors: _errCount(n.id),
          inFlight: _inFlight(n.id),
          stressed: _isStressed(n.id),
          failing: _isFailing(n.id),
          capacity: n.concurrencyLimit
            ? `${_inFlight(n.id)}/${n.concurrencyLimit}`
            : "unlimited",
        })),
        t2Pool: T2_NODES.map((n) => ({ id: n.id, errors: _errCount(n.id) })),
        fleetNodes: _nodeMetrics.size,
      });
    }

    // ── Hub test ────────────────────────────────────────────────────────────
    if (url.pathname === "/hub-test") {
      const nodes = getNodes(env);
      const liveHealth = await Promise.all(
        nodes.map((n) =>
          fetchNodeHealth(n.url).then((h) => ({
            id: n.id,
            name: n.name,
            health: h,
          })),
        ),
      );
      return jsonOk({
        discordConfigured: !!env.DISCORD_WEBHOOK_URL,
        kvConfigured: !!env.DASHBOARD_KV,
        lastDiscordUpdate: _lastDiscordUpdate
          ? new Date(_lastDiscordUpdate).toISOString()
          : null,
        t1Pool: T1_NODES.map((n) => ({
          id: n.id,
          errors: _errCount(n.id),
          inFlight: _inFlight(n.id),
          cpuAlloc: n.cpuAlloc,
          concurrencyLimit: n.concurrencyLimit,
        })),
        t2Pool: T2_NODES.map((n) => ({ id: n.id })),
        storedMetrics: Object.fromEntries(_nodeMetrics),
        liveHealth,
      });
    }

    // ── Fleet dashboard helpers ─────────────────────────────────────────────
    if (url.pathname === "/report") return handleReport(request, env, ctx);
    if (url.pathname === "/ss") return handleScreenshot(request, env);
    if (url.pathname === "/proxy") return handleProxy(request);

    // ── Main rasterization entry point ──────────────────────────────────────
    if (request.method !== "POST" && request.method !== "GET")
      return jsonError(405, "Method not allowed");

    // Read headers
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

    // Parse SVG body
    let svgText;
    if (request.method === "POST") {
      svgText = await request.text();
      if (!svgText?.trim()) return jsonError(400, "Empty SVG body");
    } else {
      // GET ?url= path (from external callers, not from Worker A)
      const targetUrl = url.searchParams.get("url");
      if (!targetUrl) return jsonError(400, "Missing ?url= parameter");
      try {
        const parsedTarget = new URL(targetUrl);
        if (!["http:", "https:"].includes(parsedTarget.protocol))
          return jsonError(400, "Invalid URL protocol");
        const r = await fetch(parsedTarget.toString(), {
          headers: { "User-Agent": "SpicyDevs-LB/11.0" },
        });
        if (!r.ok) return jsonError(502, `SVG fetch failed: ${r.status}`);
        svgText = await r.text();
      } catch (e) {
        return jsonError(502, `SVG fetch error: ${e?.message}`);
      }
    }

    return _distributedRender(
      svgText,
      svgUrl,
      format,
      colo,
      fallbackImageUrl,
      posterUrl,
      inputType,
      env,
    );
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(updateDashboard(env, true));
  },
};
