// cloudflare/worker.js — v12
//
// PURE LOAD BALANCER — No WASM, No Puppeteer
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
// ── T1 Pool (geo+score ordered, tried first) ──────────────────────────────────
//   washington  Vercel US East      — URL-payload (GET ?url=)
//   ohio        Netlify US Central  — POST body
//   midas       Spaceify DE2        — POST body
//   germany     Spaceify DE20       — POST body
//   danbot      DanBot EU           — POST body
//   wsrv        wsrv.nl Global      — URL-payload (librsvg)
//
// ── T2 Pool (extreme fallback only, longer timeout) ───────────────────────────
//   france      Spaceify FR         — POST body
//   render_eu   Render EUC          — POST body
//
// ── Analytics schema (RASTER_METRICS) ────────────────────────────────────────
// Per-attempt datapoint:
//   blob1 = nodeId
//   blob2 = format             'png' | 'jpg' | 'webp'
//   blob3 = inputType          'movie' | 'tv' | 'anime'
//   blob4 = colo               CF datacenter code
//   blob5 = outcome            'success' | 'failure' | 'skipped'
//   blob6 = errorReason        '' on success, 'timeout' | 'http_NNN' | 'throw:...' on fail
//   blob7 = lane               't1' | 't2' | 'url_payload'
//   blob8 = wasWinner          '1' | '0'
//   double1 = attemptMs        wall time for this single node attempt
//   double2 = httpStatus       200 | 502 | 504 | 0
//   double3 = isWinner         1.0 | 0.0  — sum() gives wins per node
//   double4 = inflightCount    concurrent requests on node at attempt start
//   double5 = payloadKb        SVG payload size in KB
//
// Per-request summary datapoint (blob1 = 'req'):
//   double1 = totalWallMs
//   double2 = attemptsMade
//   double3 = 1                for count queries
//   double4 = posterEmbedMs
//   double5 = payloadKb
// double6 = nodeScoreAtSelection  EMA score at moment of selection (lower = better)
//
// ── CPU performance proxy (useful AE query) ───────────────────────────────────
//   Serial-equivalent CPU time ≈ double1 * (1 + double4)
//   Compare this across nodes to rank relative CPU speed without knowing specs:
//   SELECT blob1 AS node,
//          avg(double1) AS avg_ms,
//          avg(double1 * (1 + double4)) AS cpu_proxy_ms,
//          count() AS samples
//   FROM raster_metrics
//   WHERE timestamp > now() - INTERVAL '7' DAY
//     AND blob5 = 'success' AND blob1 != 'req'
//   GROUP BY node ORDER BY cpu_proxy_ms ASC

import NODE_CONFIG from "../assets/nodes.config.js";

// ── Structured logger ──────────────────────────────────────────────────────────

function _log(level, event, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    lb: "cf-v12",
    ...meta,
  };
  (level === "error" ? console.error : console.log)(JSON.stringify(entry));
}

// ADD near top of cloudflare/worker.js
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

// ── Node pools ─────────────────────────────────────────────────────────────────
// AFTER
const T1_NODES = NODE_CONFIG.nodes
  .filter((n) => n.features.inLbWorker)
  .sort((a, b) => (a.specs.tier ?? 99) - (b.specs.tier ?? 99))
  .map((n) => ({
    id: n.id,
    type: n.type,
    baseUrl: n.url, // health check URL (no apiPath)
    url: `${n.url}${n.features.apiPath ?? ""}`, // raster POST URL
    lbRegion: n.lbRegion,
    concurrencyLimit: n.concurrencyLimit ?? null,
    useUrlPayload: n.features.useUrlPayload ?? false,
    acceptsCompression: n.features.acceptsCompression ?? false, // 'gzip' | 'br' | false
    supportsHealthCheck: n.features.supportsHealthCheck ?? false,
  }));

const T2_NODES = NODE_CONFIG.nodes
  .filter((n) => n.features.isLbFallback)
  .map((n) => ({
    id: n.id,
    type: n.type,
    baseUrl: n.url,
    url: `${n.url}${n.features.apiPath ?? ""}`,
    lbRegion: n.lbRegion,
    concurrencyLimit: n.concurrencyLimit ?? null,
    useUrlPayload: false,
    acceptsCompression: n.features.acceptsCompression ?? false,
    supportsHealthCheck: n.features.supportsHealthCheck ?? false,
  }));

// Module-level tuned concurrency limits written by auto-tune cron
let _lastDiscordUpdate = 0; // ADD THIS
const {
  t1TimeoutMs = 5_000,
  t2TimeoutMs = 8_000,
  posterEmbedTimeoutMs = 6_000,
  maxWallTimeMs = 7_000,
  stressThreshold = 3,
  failingThreshold = 8,
  errWindowMs = 60_000,
} = NODE_CONFIG.settings;

// ── Per-isolate health & EMA performance state ─────────────────────────────────
// ADD near top of cloudflare/worker.js
let _scoreCache = { data: {}, fetchedAt: 0 };
const SCORE_CACHE_TTL_MS = 5_000;

async function _refreshScores(env) {
  if (Date.now() - _scoreCache.fetchedAt < SCORE_CACHE_TTL_MS)
    return _scoreCache.data;
  try {
    const id = env.FLEET_HEALTH.idFromName("global");
    const stub = env.FLEET_HEALTH.get(id);
    const res = await stub.fetch("https://fleet-health.internal/scores");
    _scoreCache = { data: await res.json(), fetchedAt: Date.now() };
  } catch (_) {
    /* keep stale cache on error */
  }
  return _scoreCache.data;
}

function _reportOutcome(env, ctx, nodeId, ok, ms) {
  ctx.waitUntil(
    (async () => {
      try {
        const id = env.FLEET_HEALTH.idFromName("global");
        const stub = env.FLEET_HEALTH.get(id);
        await stub.fetch("https://fleet-health.internal/report", {
          method: "POST",
          body: JSON.stringify({ nodeId, ok, ms }),
        });
      } catch (_) {}
    })(),
  );
}
/** nodeId → { count, windowEnd } */
const _errMap = new Map();
/** nodeId → current in-flight count */
const _inflightMap = new Map();
/** nodeId → { emaMs, sampleCount } */
const _perfMap = new Map();

const EMA_ALPHA = 0.2; // smoothing factor — higher = more reactive
// ADD (new function)
function _hashStr(str) {
  let h = 0x811c9dc5;
  const len = Math.min(str.length, 512);
  for (let i = 0; i < len; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}
// Error tracking
function _recordErr(id) {
  const now = Date.now();
  let e = _errMap.get(id) ?? { count: 0, windowEnd: now + errWindowMs };
  if (now > e.windowEnd) e = { count: 0, windowEnd: now + errWindowMs };
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

// EMA performance tracking
function _recordPerf(id, ms) {
  const p = _perfMap.get(id);
  if (!p) {
    _perfMap.set(id, { emaMs: ms, sampleCount: 1 });
  } else {
    p.emaMs = EMA_ALPHA * ms + (1 - EMA_ALPHA) * p.emaMs;
    p.sampleCount += 1;
  }
}
function _emaMs(id) {
  return _perfMap.get(id)?.emaMs ?? 9_999;
}

/**
 * Node score — lower is better.
 * Combines EMA response time + error penalty + concurrency penalty.
 * Use this to compare node performance even without knowing their CPU specs.
 */
function _nodeScore(id) {
  return (
    _emaMs(id) +
    _errCount(id) * 500 + // 500 ms penalty per recent error
    _inFlight(id) * 80
  ); // 80 ms penalty per concurrent inflight request
}

// ── Geo region mapping ─────────────────────────────────────────────────────────

const COLO_REGION = (() => {
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

/**
 * Returns T1 nodes in geo-preferred + score order.
 * Same-region nodes first, both halves sorted by _nodeScore ascending.
 * Failing nodes are pushed to the back within each group.
 */
function _geoOrderNodes(colo) {
  const req = (colo && COLO_REGION[colo.toUpperCase()]) || "NA";
  const same = T1_NODES.filter((n) => n.lbRegion === req);
  const other = T1_NODES.filter((n) => n.lbRegion !== req);
  const byScore = (a, b) => {
    // Hard-failing nodes always go last within their geo group
    const fa = _isFailing(a.id) ? 1 : 0;
    const fb = _isFailing(b.id) ? 1 : 0;
    if (fa !== fb) return fa - fb;
    return _nodeScore(a.id) - _nodeScore(b.id);
  };
  return [...same.sort(byScore), ...other.sort(byScore)];
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
// Worker A sends poster image as an href URL in the SVG body.
// We fetch it once here and replace all occurrences with a base64 data URI.
// This eliminates the double-fetch problem where each raster node would have
// independently fetched the same poster image.
// AFTER
async function _embedPoster(svgText, posterUrl) {
  if (!posterUrl) return { svg: svgText, embedMs: 0, embedded: false };

  // Cache key: poster URL + hash of first 512 chars of SVG (captures layout but not base64 poster)
  const cacheKey = `poster-embed:${_hashStr(posterUrl)}:${_hashStr(svgText.slice(0, 512))}`;
  const cacheReq = new Request(`https://embed-cache.internal/${cacheKey}`);
  const cache = caches.default;

  try {
    const hit = await cache.match(cacheReq);
    if (hit) {
      const svg = await hit.text();
      _log("debug", "embed_cache_hit", { key: cacheKey.slice(0, 40) });
      return { svg, embedMs: 0, embedded: true, fromCache: true };
    }
  } catch (_) {
    /* cache miss on error is fine */
  }

  const t0 = Date.now();
  try {
    const res = await fetch(posterUrl, {
      signal: AbortSignal.timeout(posterEmbedTimeoutMs),
      headers: { "User-Agent": "SpicyDevs-LB/13.0", Accept: "image/*" },
      cf: { cacheTtl: 86_400, cacheEverything: true },
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
    const uri = `data:${ct};base64,${_bufToB64(buf)}`;
    const svg = svgText.split(`href="${posterUrl}"`).join(`href="${uri}"`);

    // Cache embedded SVG for 5 minutes — burst traffic for same title reuses it
    try {
      await cache.put(
        cacheReq,
        new Response(svg, {
          headers: {
            "Content-Type": "image/svg+xml",
            "Cache-Control": "public, max-age=300",
          },
        }),
      );
    } catch (_) {
      /* non-fatal */
    }

    return { svg, embedMs: Date.now() - t0, embedded: true };
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
  const inflightAtStart = _inFlight(node.id);
  try {
    let res;
    if (node.useUrlPayload && svgUrl) {
      let target;
      if (node.id === "wsrv") {
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
        // Vercel: GET ?url=&format=
        const u = new URL(node.url);
        u.searchParams.set("url", svgUrl);
        u.searchParams.set("format", format);
        target = u.toString();
      }
      res = await fetch(target, {
        method: "GET",
        headers: { "User-Agent": "SpicyDevs-LB/12.0" },
        signal,
      });
    } else {
      // Body POST path — optionally gzip
      let body = svgText,
        ct = "image/svg+xml";
      const extra = {};
      // AFTER
      if (
        node.acceptsCompression === "gzip" ||
        node.acceptsCompression === true
      ) {
        const gz = await _gzip(svgText);
        if (gz) {
          body = gz;
          ct = "application/octet-stream";
          extra["X-SVG-Encoding"] = "gzip";
        }
      }
      // 'br' reserved for when CF Workers' CompressionStream adds brotli support
      res = await fetch(node.url, {
        method: "POST",
        body,
        headers: {
          "Content-Type": ct,
          "X-Format": format,
          "User-Agent": "SpicyDevs-LB/12.0",
          ...extra,
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
        inflightAtStart,
      };
    }
    _recordOk(node.id);
    return { ok: true, res, error: "", status: res.status, inflightAtStart };
  } catch (e) {
    // AbortError is expected/benign here — either our own budget timeout
    // fired, or this racer lost the pair and ac.abort() cancelled it.
    // Never record it as a node error (it's not the node's fault) and
    // never let it escape uncaught.
    if (e?.name !== "AbortError") _recordErr(node.id);
    return {
      ok: false,
      res: null,
      inflightAtStart,
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

// ── Analytics helpers ──────────────────────────────────────────────────────────
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
    nodeScore = 0, // ← ADD
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
        nodeScore,
      ], // ← ADD nodeScore
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

// ── Response builder ───────────────────────────────────────────────────────────

// AFTER
function _buildImageResp(
  upstream,
  nodeId,
  attemptCount,
  wallMs,
  embedMs,
  colo,
) {
  const h = new Headers(upstream.headers);
  const geoRegion = (colo && COLO_REGION[colo.toUpperCase()]) || "UNKNOWN";
  h.set("Access-Control-Allow-Origin", "*");
  h.set("X-Raster-Source", nodeId);
  h.set("X-Attempt-Count", String(attemptCount));
  h.set("X-Wall-Ms", String(wallMs));
  h.set("X-Poster-Embed-Ms", String(embedMs));
  h.set("X-Node-Score", String(Math.round(_nodeScore(nodeId))));
  h.set("X-Score", String(Math.round(_nodeScore(nodeId)))); // alias for debugging
  h.set("X-Geo-Preferred", geoRegion); // which region was preferred
  h.set("X-CF-Colo", colo || ""); // exact CF datacenter
  h.set("X-LB-Version", "cf-v13");
  h.set("Cache-Control", "public, max-age=172800");
  h.set(
    "Access-Control-Expose-Headers",
    "X-Raster-Source,X-Attempt-Count,X-Wall-Ms,X-Poster-Embed-Ms,X-Node-Score,X-Score,X-Geo-Preferred,X-CF-Colo,X-LB-Version",
  );
  return new Response(upstream.body, { status: 200, headers: h });
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

  const _elapsed = () => Date.now() - tWall0;
  const _timedOut = () => _elapsed() >= maxWallTimeMs;

  // Step 1: Embed poster once in this worker
  const {
    svg: embeddedSvg,
    embedMs,
    embedded,
  } = await _embedPoster(svgText, posterUrl);

  _log("info", "render_start", {
    colo,
    format,
    inputType,
    payloadKb,
    embedMs,
    embedded,
  });

  // Step 2: T1 nodes with pair-racing concurrency
  const HARD_WALL_MS = 5_000;
  const wallDeadline = Math.min(maxWallTimeMs, HARD_WALL_MS);
  const ordered = _geoOrderNodes(colo);

  // Ensure wsrv is present as a fallback option within the pool if not already
  const racePool = [...ordered];
  if (!racePool.some((n) => n.id === "wsrv")) {
    const wsrvNode = T1_NODES.find((n) => n.id === "wsrv");
    if (wsrvNode) racePool.push(wsrvNode);
  }

  const GROUP_SIZE = 2;

  // Inline helper to preserve context and safely increment outer state
  async function _raceGroup(nodes, budgetMs) {
    // FIX: previously ONE AbortController was shared by every racer in the
    // pair. The moment a winner resolved we called ac.abort() to cancel the
    // loser — but the winner's own in-flight fetch used that *same* signal,
    // so the abort ALSO tore down the winner's still-streaming response
    // body. Reading that body later (while proxying it back through Worker
    // A) threw "The operation was aborted" outside any try/catch here —
    // exactly the uncaught AbortError + outcome:"exception" in the
    // rasterize worker logs, and "Rasterizer binding threw" one hop up.
    //
    // Fix: one controller per racer. On a win, abort every OTHER racer's
    // controller — never the winner's — so its body stream survives.
    const nodeControllers = nodes.map(() => new AbortController());
    let winnerIdx = -1;

    const abortLosers = (exceptIdx) => {
      nodeControllers.forEach((c, i) => {
        if (i !== exceptIdx && !c.signal.aborted) c.abort();
      });
    };

    const timer = setTimeout(() => abortLosers(winnerIdx), budgetMs);

    const promises = nodes.map(async (node, idx) => {
      if (_atCapacity(node)) {
        _log("info", "t1_skip_capacity", {
          node: node.id,
          inflight: _inFlight(node.id),
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
          inflightCount: _inFlight(node.id),
          payloadKb,
        });
        return { ok: false, node };
      }

      attemptsMade++;
      // Capture this racer's own attempt number NOW. Both racers in a pair
      // increment attemptsMade synchronously before either awaits, so
      // reading the shared counter later (at log time) made both racers'
      // logs report the same final value — this is why your logs show
      // BOTH washington and ohio as "attempt: 2" in the same group.
      const myAttemptNum = attemptsMade;
      const scoreAtSelection = Math.round(_nodeScore(node.id));
      const t0 = Date.now();

      const result = await _tryNode(
        node,
        embeddedSvg,
        svgUrl,
        format,
        nodeControllers[idx].signal,
      );
      const attemptMs = Date.now() - t0;

      _logAttempt(env, {
        nodeId: node.id,
        format,
        inputType,
        colo,
        outcome: result.ok ? "success" : "failure",
        errorReason: result.error,
        lane: node.useUrlPayload ? "url_payload" : "t1_race",
        isWinner: result.ok,
        attemptMs,
        httpStatus: result.status,
        inflightCount: result.inflightAtStart,
        payloadKb,
        nodeScore: scoreAtSelection,
      });

      if (result.ok) {
        _recordPerf(node.id, attemptMs);
        _log("info", "t1_success", {
          node: node.id,
          attempt: myAttemptNum,
          attemptMs,
        });
      } else {
        _log("warn", "t1_failed", {
          node: node.id,
          attempt: myAttemptNum,
          error: result.error,
          attemptMs,
        });
      }

      return { ...result, node, attemptMs };
    });

    try {
      return await new Promise((resolve) => {
        let remaining = promises.length;
        if (remaining === 0) resolve({ ok: false });

        promises.forEach((p, idx) =>
          p
            .then((r) => {
              if (r.ok) {
                // Cancel every OTHER racer — never this one — so the
                // winner's response body is never torn down mid-stream.
                winnerIdx = idx;
                abortLosers(idx);
                resolve(r);
              } else {
                remaining--;
                if (remaining === 0) resolve(r); // All items in this group failed
              }
            })
            .catch((err) => {
              // Defensive: _tryNode never rejects internally, but a rejection
              // that lands after abort() has already fired (loser's fetch
              // throwing AbortError post-resolve) was surfacing as an
              // uncaught exception on the isolate (outcome:"exception")
              // even though a valid response had already been returned.
              remaining--;
              _log("warn", "race_promise_settle_error", {
                reason: err?.message || String(err),
              });
              if (remaining === 0) resolve({ ok: false });
            }),
        );
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // Execute race groups sequentially
  for (let i = 0; i < racePool.length; i += GROUP_SIZE) {
    if (Date.now() - tWall0 >= wallDeadline) {
      _log("warn", "t1_race_wall_timeout_abort", { elapsed: _elapsed() });
      break;
    }

    const group = racePool.slice(i, i + GROUP_SIZE);
    const remainingBudget = wallDeadline - _elapsed();
    if (remainingBudget <= 200) break;

    const winner = await _raceGroup(group, remainingBudget);
    if (winner.ok) {
      _logRequest(env, {
        format,
        inputType,
        colo,
        totalWallMs: _elapsed(),
        attemptsMade,
        posterEmbedMs: embedMs,
        payloadKb,
        outcome: "success",
      });
      return _buildImageResp(
        winner.res,
        winner.node.id,
        attemptsMade,
        _elapsed(),
        embedMs,
        colo,
      );
    }
  }

  // Step 3: T2 extreme fallback (only if wall time budget remains)
  for (const node of T2_NODES) {
    if (_timedOut()) {
      _log("warn", "t2_wall_timeout_abort", { elapsed: _elapsed() });
      break;
    }

    attemptsMade++;
    const budget = Math.max(1_000, maxWallTimeMs - _elapsed() - 150);
    const nodeTimeout = Math.min(t2TimeoutMs, budget);

    _log("warn", "t2_attempt", {
      node: node.id,
      reason: "all_t1_failed",
      timeout: nodeTimeout,
    });

    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), nodeTimeout);
    const t0 = Date.now();
    const { ok, res, error, status, inflightAtStart } = await _tryNode(
      node,
      embeddedSvg,
      svgUrl,
      format,
      ac.signal,
    )
      .catch((err) => ({
        ok: false,
        res: null,
        error: `throw:${err?.message?.slice(0, 60) || "unknown"}`,
        status: 0,
        inflightAtStart: 0,
      }))
      .finally(() => clearTimeout(tm));
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
      inflightCount: inflightAtStart,
      payloadKb,
    });

    if (ok) {
      _recordPerf(node.id, attemptMs);
      _log("info", "t2_success", { node: node.id, attemptMs });
      _logRequest(env, {
        format,
        inputType,
        colo,
        totalWallMs: _elapsed(),
        attemptsMade,
        posterEmbedMs: embedMs,
        payloadKb,
        outcome: "success_t2",
      });
      return _buildImageResp(res, node.id, attemptsMade, _elapsed(), embedMs);
    }

    _log("error", "t2_failed", { node: node.id, error, attemptMs });
  }

  // Step 4: All exhausted — 302 to fallback image or 502
  const wallMs = _elapsed();
  _log("error", "chain_exhausted", {
    colo,
    format,
    attempts: attemptsMade,
    wallMs,
  });
  _logRequest(env, {
    format,
    inputType,
    colo,
    totalWallMs: wallMs,
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
        "X-Raster-Source": "fallback-redirect",
        "X-Failure-Reason": "all_nodes_exhausted",
        "X-Attempt-Count": String(attemptsMade),
        "X-Wall-Ms": String(wallMs),
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

// ── Fleet dashboard ────────────────────────────────────────────────────────────

async function _fetchNodeHealth(baseUrl) {
  try {
    const r = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(4_000),
      headers: { "User-Agent": "SpicyDevs-LB/12.0" },
    });
    return r.ok ? await r.json().catch(() => null) : null;
  } catch {
    return null;
  }
}
// REPLACE the entire _updateDashboard function:

async function _updateDashboard(env, isCron = false) {
  if (!env.DISCORD_WEBHOOK_URL) return;
  _lastDiscordUpdate = Date.now();

  const allNodes = [...T1_NODES, ...T2_NODES];

  // Only health-check nodes that expose /health; skip CDN/wsrv nodes
  const healths = await Promise.all(
    allNodes.map(async (n) => {
      if (!n.supportsHealthCheck) return { ...n, h: null };
      const h = await _fetchNodeHealth(n.baseUrl);
      return { ...n, h };
    }),
  );

  // 🟢 online  🟡 stressed  🟠 failing  🔴 VPS down  💤 serverless cold  ⚪ CDN/no-healthcheck
  const emoji = (n, health) => {
    if (!n.supportsHealthCheck) return "⚪"; // CDN or no endpoint
    if (!health) {
      if (n.type === "vercel" || n.type === "netlify") return "💤"; // cold start
      return "🔴"; // VPS actually down
    }
    if (_isFailing(n.id)) return "🟠";
    if (_isStressed(n.id)) return "🟡";
    return "🟢";
  };

  const fields = healths.map(({ id, type, h, supportsHealthCheck }) => {
    const perf = _perfMap.get(id);
    const limit =
      T1_NODES.find((n) => n.id === id)?.concurrencyLimit ??
      T2_NODES.find((n) => n.id === id)?.concurrencyLimit ??
      null;
    const limitStr = limit != null ? `/${limit}` : "/∞";

    const healthLine = !supportsHealthCheck
      ? "CDN / No health endpoint"
      : !h
        ? type === "vercel" || type === "netlify"
          ? "Serverless — may be cold"
          : "❌ Offline"
        : `Active: ${h.activeJobs ?? "?"}  Queue: ${h.queuedJobs ?? "?"}  Up: ${h.uptime != null ? `${Math.floor(h.uptime / 3600)}h${Math.floor((h.uptime % 3600) / 60)}m` : "?"}`;

    const lines = [
      `${emoji({ id, type, supportsHealthCheck }, h)} **${id}**`,
      healthLine,
      `Errors: ${_errCount(id)}  In-flight: ${_inFlight(id)}${limitStr}`,
      perf
        ? `EMA: ${Math.round(perf.emaMs)}ms  Score: ${Math.round(_nodeScore(id))}  n=${perf.sampleCount}`
        : "No samples yet",
    ]
      .filter(Boolean)
      .join("\n");

    return { name: "\u200B", value: lines, inline: true };
  });

  const anyFailing = allNodes.some((n) => _isFailing(n.id));
  const anyStressed = allNodes.some((n) => _isStressed(n.id));

  const payload = {
    username: "Posterium LB — v13",
    embeds: [
      {
        title: "🖼️ Raster Node Fleet",
        color: anyFailing ? 0xf87171 : anyStressed ? 0xfacc15 : 0x4ade80,
        fields,
        // AFTER
        footer: { text: `Hourly poll · ${new Date().toISOString()}` },
      },
    ],
  };

  // ── Edit existing message or create new ───────────────────────────────────
  let messageId = null;
  try {
    messageId = await env.DASHBOARD_KV?.get("discord:messageId");
  } catch (_) {}

  if (messageId) {
    try {
      const editRes = await fetch(
        `${env.DISCORD_WEBHOOK_URL}/messages/${messageId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (editRes.ok) return; // success — done
      if (editRes.status === 404) {
        // Message was deleted from Discord — clear the stored ID and fall through
        await env.DASHBOARD_KV?.delete("discord:messageId").catch(() => {});
        messageId = null;
      } else {
        _log("warn", "discord_edit_failed", { status: editRes.status });
      }
    } catch (e) {
      _log("warn", "discord_edit_threw", { reason: e?.message });
    }
  }

  // Create new message — use ?wait=true to get message ID back
  try {
    const postRes = await fetch(`${env.DISCORD_WEBHOOK_URL}?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    });
    if (postRes.ok) {
      const data = await postRes.json();
      if (data.id) {
        await env.DASHBOARD_KV?.put("discord:messageId", data.id).catch(
          () => {},
        );
      }
    } else {
      _log("warn", "discord_post_failed", { status: postRes.status });
    }
  } catch (e) {
    _log("warn", "discord_post_threw", { reason: e?.message });
  }
}

// ── Proxy helper (dashboard — proxies health checks through CF to avoid mixed-content) ──

async function _handleProxy(request) {
  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  if (!target) return _jsonError(400, "Missing ?url=");
  const allowed = NODE_CONFIG.nodes.map((n) => new URL(n.url).host);
  const tHost = (() => {
    try {
      return new URL(target).host;
    } catch {
      return "";
    }
  })();
  if (!allowed.includes(tHost)) return _jsonError(403, "URL not in allowlist");
  try {
    const res = await fetch(target, {
      headers: { "User-Agent": "SpicyDevs-LB/12.0" },
      signal: AbortSignal.timeout(8_000),
    });
    const h = new Headers(res.headers);
    h.set("Access-Control-Allow-Origin", "*");
    return new Response(res.body, { status: res.status, headers: h });
  } catch (e) {
    return _jsonError(502, e?.message);
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function _bufToB64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 32_768)
    bin += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + 32_768, bytes.length)),
    );
  return btoa(bin);
}

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
        version: "12.0",
        node: "cf-lb",
        t1Pool: T1_NODES.map((n) => ({
          id: n.id,
          errors: _errCount(n.id),
          inFlight: _inFlight(n.id),
          stressed: _isStressed(n.id),
          failing: _isFailing(n.id),
          emaMs: Math.round(_emaMs(n.id)),
          score: Math.round(_nodeScore(n.id)),
          samples: _perfMap.get(n.id)?.sampleCount ?? 0,
          capacity:
            n.concurrencyLimit != null
              ? `${_inFlight(n.id)}/${n.concurrencyLimit}`
              : "unlimited",
        })),
        t2Pool: T2_NODES.map((n) => ({
          id: n.id,
          errors: _errCount(n.id),
          emaMs: Math.round(_emaMs(n.id)),
          score: Math.round(_nodeScore(n.id)),
        })),
        settings: {
          t1TimeoutMs,
          t2TimeoutMs,
          maxWallTimeMs,
          posterEmbedTimeoutMs,
        },
      });
    }

    // ── /hub-test ──────────────────────────────────────────────────────────
    if (url.pathname === "/hub-test") {
      const allNodes = [...T1_NODES, ...T2_NODES];
      const liveHealth = await Promise.all(
        allNodes.map((n) =>
          _fetchNodeHealth(n.baseUrl).then((h) => ({
            id: n.id,
            health: h,
            emaMs: Math.round(_emaMs(n.id)),
            score: Math.round(_nodeScore(n.id)),
            errors: _errCount(n.id),
            inFlight: _inFlight(n.id),
            samples: _perfMap.get(n.id)?.sampleCount ?? 0,
          })),
        ),
      );
      return _jsonOk({
        discordConfigured: !!env.DISCORD_WEBHOOK_URL,
        lastDiscordUpdate: _lastDiscordUpdate
          ? new Date(_lastDiscordUpdate).toISOString()
          : null,
        t1Pool: T1_NODES.map((n) => ({
          id: n.id,
          errors: _errCount(n.id),
          inFlight: _inFlight(n.id),
          emaMs: Math.round(_emaMs(n.id)),
          score: Math.round(_nodeScore(n.id)),
          concurrencyLimit: n.concurrencyLimit,
        })),
        t2Pool: T2_NODES.map((n) => ({ id: n.id, errors: _errCount(n.id) })),
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
    ctx.waitUntil(_updateDashboard(env));
  },
};
