// cloudflare/lib/raceDispatch.js
//
// v17 — fixes:
//   • v16: In-flight attempts are NO LONGER aborted when a phase budget
//     expires. Previous behavior: the budget timer (SEQUENTIAL_ATTEMPT_MS =
//     1.5s) aborted every in-flight node, including the original phase-1
//     pick, even when that node was about to succeed (e.g. a healthy node
//     that needs 1.8s was killed at 1.5s, then the fallback chain re-burned
//     budget on fresh nodes that are no more likely to finish sooner).
//     Now attempts keep running in a background pool: the next phase races
//     the new node(s) AGAINST the still-pending attempts, so whichever
//     resolves successfully first wins the request. A winner (or chain
//     exhaustion) aborts everything else, so no dangling subrequests leak.
//   • v17: Poster embedding + gzip are now LAZY. The poster is fetched and
//     base64-embedded (and the SVG gzipped) only when a POST-body node is
//     actually about to be attempted. URL-payload nodes (wsrv, Vercel GET)
//     fetch the SVG themselves via svgUrl and never touch the embedded
//     body, so when Phase 1's single best node is a URL-payload node the
//     request pays zero embed/gzip cost. Both are memoized per request:
//     the first POST attempt pays them once, every later POST attempt
//     reuses the same embedded SVG + gzipped payload. If the embed fails,
//     the raw (unembedded) SVG is sent and the node fetches the poster
//     href itself.
//   • Every node attempt still writes a full-fidelity row straight to
//     RASTER_METRICS via logAttempt() — node, format, type, colo, outcome,
//     error, lane, wasWinner, wall ms, node-reported compute ms, in-flight
//     count, payload size, EMA score at selection. isWinner is decided once
//     per request after a winner is chosen; attempts settling later log as
//     losers, exactly once.
//   • logEmbed() writes one RASTER_METRICS 'embed' row per request
//     (embedMs, gzipMs, payloadBytes, cache hit/miss) so embed-cache hit
//     rate and gzip cost stay visible in the dashboard.
//   • logRequest() remains removed — the per-request 'req' summary row is
//     written exactly once by Worker A (writeWallTime).
//
// fleetBridge.refreshScores feeds the KV fleet snapshot (written every
// 15 minutes by fleetSync.js from Analytics Engine stats + health polls)
// into the per-isolate health state, cached 5s per isolate. reportBatch is
// a no-op — per-attempt routing analytics go straight to RASTER_METRICS by
// logAttempt(); the snapshot's score/failing/concurrency are derived from
// that same data at cron time.

import { geoOrderNodes, getRegion } from "./geoRouting.js";
import { tryNode, gzip } from "./nodeAttempt.js";
import { embedPoster } from "./embedding.js";
import { logAttempt, logEmbed } from "./metricsWriter.js";

const HARD_WALL_MS = 5_000;
// Per-phase ceiling across the fallback ladder: a single hanging node must
// not be allowed to consume the entire wall budget — otherwise one timeout
// would make every later node unreachable. Healthy nodes finish in ~100-500ms,
// so 1.5s is generous while still guaranteeing the chain can walk all nodes.
// NOTE: this bounds how long we WAIT before moving to the next phase; it does
// NOT cancel the attempts (they continue in the background pool and can still
// win the request — see header comment).
const SEQUENTIAL_ATTEMPT_MS = 1_500;

const NOOP_BRIDGE = {
  refreshScores: async () => ({}),
  reportBatch: () => {},
};

function buildImageResp(
  upstream,
  nodeId,
  attemptCount,
  wallMs,
  embedMs,
  colo,
  continent,
  health,
) {
  const h = new Headers(upstream.headers);
  const geoRegion = getRegion(colo, continent);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("X-Raster-Source", nodeId);
  h.set("X-Attempt-Count", String(attemptCount));
  h.set("X-Wall-Ms", String(wallMs));
  h.set("X-Poster-Embed-Ms", String(embedMs));
  h.set("X-Node-Score", String(Math.round(health.nodeScore(nodeId))));
  h.set("X-Geo-Preferred", geoRegion);
  h.set("X-CF-Colo", colo || "");
  h.set("X-LB-Version", "cf-v17");
  h.set("Cache-Control", "public, max-age=172800");
  h.set(
    "Access-Control-Expose-Headers",
    "X-Raster-Source,X-Attempt-Count,X-Wall-Ms,X-Poster-Embed-Ms,X-Node-Score,X-Geo-Preferred,X-CF-Colo,X-LB-Version",
  );
  return new Response(upstream.body, { status: 200, headers: h });
}

export async function distributedRender({
  svgText,
  svgUrl,
  format,
  colo,
  continent,
  fallbackImageUrl,
  posterUrl,
  inputType,
  env,
  ctx,
  t1Nodes,
  t2Nodes,
  settings,
  health,
  fleetBridge,
  log,
}) {
  const bridge = fleetBridge || NOOP_BRIDGE;
  const { posterEmbedTimeoutMs, maxWallTimeMs } = settings;
  const tWall0 = Date.now();
  const payloadKb = Math.round(new Blob([svgText]).size / 1024);
  let attemptsMade = 0;
  const elapsed = () => Date.now() - tWall0;

  function reportAttempt(nodeId, ok, ms, isWinner, extra) {
    try {
      logAttempt(env, {
        nodeId,
        format,
        inputType,
        colo,
        outcome: ok ? "success" : "failure",
        errorReason: ok ? "" : extra.error || "",
        lane: extra.lane,
        isWinner,
        attemptMs: ms,
        httpStatus: extra.status ?? 0,
        inflightCount: extra.inflightAtStart ?? 0,
        payloadKb,
        nodeScore: extra.nodeScore ?? 0,
        computeMs: extra.computeMs ?? 0,
      });
    } catch (_) {}
  }

  try {
    health.mergeSnapshot(await bridge.refreshScores(env));
  } catch (_) {
    /* stale/local health state is fine — routing still works */
  }

  const wallDeadline = Math.min(maxWallTimeMs, HARD_WALL_MS);
  const ordered = geoOrderNodes(colo, t1Nodes, health, continent);
  const racePool = [...ordered];

  // ── Lazy poster embed + gzip (v17) ─────────────────────────────────────────
  // Both are computed only when a POST-body node is about to be attempted,
  // and memoized per request. URL-payload nodes (wsrv/Vercel GET) fetch the
  // SVG themselves via svgUrl and never use the embedded body, so a request
  // won by a URL-payload node never pays fetch+base64+gzip at all.
  let embedPromise = null;
  let embeddedSvg = null;
  let embedMs = 0;
  let embedRan = false;
  let embedded = false;
  let fromCache = false;
  let gzPromise = null;
  let gzPayload = null;
  let gzipMs = 0;

  function ensureEmbeddedSvg() {
    if (!embedPromise) {
      embedPromise = (async () => {
        const r = await embedPoster(
          svgText,
          posterUrl,
          env,
          posterEmbedTimeoutMs,
          log,
        );
        embedded = r.embedded;
        fromCache = !!r.fromCache;
        embeddedSvg = r.svg;
        embedMs = r.embedMs;
        return r.svg;
      })();
    }
    return embedPromise;
  }

  function ensureGzPayload(svg) {
    if (!gzPromise) {
      gzPromise = (async () => {
        const t0 = Date.now();
        const gz = await gzip(svg);
        gzipMs = Date.now() - t0;
        gzPayload = gz;
        return gz;
      })();
    }
    return gzPromise;
  }

  function reportEmbed() {
    try {
      logEmbed(env, {
        format,
        inputType,
        colo,
        outcome: embedRan ? (embedded ? "success" : "failure") : "skipped",
        cache: fromCache ? "hit" : embedRan && posterUrl ? "miss" : "none",
        embedMs,
        gzipMs,
        payloadBytes: new Blob([embeddedSvg || svgText]).size,
      });
    } catch (_) {}
  }

  // ── Background attempt pool ───────────────────────────────────────────────
  // Attempts survive their phase: when a phase budget expires we move on
  // without aborting, and the next phase races fresh nodes against the
  // still-pending attempts. Whichever resolves successfully first wins.
  // A chosen winner (or chain exhaustion) aborts everything else.
  let winnerKey = null; // key of the winning attempt, or 'none' if exhausted
  const pool = new Map(); // attemptKey -> record
  let attemptSeq = 0;

  function logAttemptRecord(rec) {
    if (rec.logged) return;
    rec.logged = true;
    reportAttempt(rec.node.id, rec.result.ok, rec.result.ms, rec.key === winnerKey, {
      error: rec.result.error,
      status: rec.result.status,
      inflightAtStart: rec.result.inflightAtStart,
      nodeScore: health.nodeScore(rec.node.id),
      computeMs: rec.result.computeMs,
      lane: rec.lane,
    });
  }

  function settleRecord(rec, result) {
    rec.result = result;
    rec.settled = true;
    if (winnerKey) logAttemptRecord(rec);
  }

  function abortPool(exceptKey) {
    pool.forEach((rec) => {
      if (rec.key !== exceptKey && !rec.controller.signal.aborted) {
        rec.controller.abort();
      }
    });
  }

  function startAttempt(node, lane) {
    if (health.atCapacity(node)) return null;
    attemptsMade++;
    const key = `a${attemptSeq++}`;
    const t0 = Date.now();
    const controller = new AbortController();
    const rec = {
      key,
      node,
      lane,
      t0,
      controller,
      promise: null,
      settled: false,
      logged: false,
      result: null,
    };
    let tNode = t0;
    rec.promise = (async () => {
      // Build the payload ONLY for nodes that actually consume it. POST-body
      // nodes get the embedded SVG + gzipped payload (lazily, once per
      // request); URL-payload nodes take the raw path via svgUrl.
      // Embed/gzip time is excluded from attemptMs — it is tracked
      // separately (embedMs / gzipMs) so node timing stays comparable.
      let body = svgText;
      let gz = null;
      if (!node.useUrlPayload) {
        embedRan = true;
        body = await ensureEmbeddedSvg();
        if (
          node.acceptsCompression === "gzip" ||
          node.acceptsCompression === true
        ) {
          gz = await ensureGzPayload(body);
        }
      }
      tNode = Date.now();
      const result = await tryNode(
        node,
        body,
        svgUrl,
        format,
        controller.signal,
        health,
        gz,
      );
      const attemptMs = Date.now() - tNode;
      if (!result.ok && result.error !== "timeout") {
        log("warn", "t1_failed", {
          node: node.id,
          error: result.error,
          attemptMs,
        });
      }
      settleRecord(rec, { ...result, ms: attemptMs });
      return rec;
    })().catch((err) => {
      log("warn", "race_promise_settle_error", {
        reason: err?.message || String(err),
      });
      settleRecord(rec, {
        ok: false,
        res: null,
        error: `throw:${err?.message?.slice(0, 60) || "unknown"}`,
        status: 0,
        ms: Date.now() - tNode || 0,
        inflightAtStart: 0,
        computeMs: 0,
      });
      return rec;
    });
    pool.set(key, rec);
    return rec;
  }

  /**
   * A winner has been chosen: log it as the winner, abort everything else,
   * and wait for the losers to settle so their analytics rows are flushed
   * before the response leaves (a returned response can freeze the isolate).
   */
  async function finalizeWinner(winner) {
    winnerKey = winner.key;
    logAttemptRecord(winner);
    abortPool(winner.key);
    await Promise.allSettled([...pool.values()].map((r) => r.promise));
    pool.forEach((rec) => logAttemptRecord(rec));
    reportEmbed();
  }

  async function raceGroup(nodes, budgetMs, lane) {
    const fresh = [];
    nodes.forEach((node) => {
      const rec = startAttempt(node, lane);
      if (rec) fresh.push(rec);
    });

    let budgetTimer = null;
    const winner = await new Promise((resolve) => {
      let remaining = fresh.length;
      if (remaining === 0) {
        // Every candidate was at capacity — an already-settled success from
        // the background pool still counts as a win.
        let bgWin = null;
        pool.forEach((rec) => {
          if (!bgWin && rec.result?.ok) bgWin = rec;
        });
        resolve(bgWin);
        return;
      }

      const onSettled = (rec) => {
        if (rec.result?.ok) {
          resolve(rec);
          return;
        }
        if (fresh.includes(rec)) {
          remaining--;
          if (remaining === 0) resolve(null);
        }
      };

      fresh.forEach((rec) => rec.promise.then(onSettled, onSettled));

      // Still-pending (or already settled) attempts from earlier phases can
      // win this race too — a slow-but-successful original node is never
      // cancelled just because its phase timed out.
      pool.forEach((rec) => {
        if (rec.settled) {
          if (rec.result?.ok) resolve(rec);
        } else {
          rec.promise.then(onSettled, onSettled);
        }
      });

      budgetTimer = setTimeout(() => resolve(null), budgetMs);
    });
    if (budgetTimer) clearTimeout(budgetTimer);

    return winner;
  }

  // ── Fallback ladder: 1 best node → parallel pair → sequential tail ──────
  // Phase 1: the single best pick (geo+score order) carries the main load.
  // Phase 2: if it fails, race the next two T1 nodes in parallel — the
  // reliability hedge (a pair wins even if one of the two hangs).
  // Phase 3: if the pair fails too, walk every remaining T1 node then all T2
  // nodes one at a time. wsrv is a normal T1 pool member — no injection.
  let cursor = 0;

  const budgetOk = () => {
    if (Date.now() - tWall0 >= wallDeadline) {
      log("warn", "t1_race_wall_timeout_abort", { elapsed: elapsed() });
      return false;
    }
    return wallDeadline - elapsed() > 200;
  };
  const attemptBudget = () =>
    Math.min(wallDeadline - elapsed(), SEQUENTIAL_ATTEMPT_MS);
  const arm = (nodes, lane) => raceGroup(nodes, attemptBudget(), lane);
  const respond = (winner) => {
    if (winner?.result?.ok) {
      return buildImageResp(
        winner.result.res,
        winner.node.id,
        attemptsMade,
        elapsed(),
        embedMs,
        colo,
        continent,
        health,
      );
    }
    return null;
  };

  // Phase 1 — single best node
  if (cursor < racePool.length && budgetOk()) {
    const winner = await arm([racePool[cursor]], "t1");
    cursor += 1;
    const resp = respond(winner);
    if (resp) {
      await finalizeWinner(winner);
      return resp;
    }
  }

  // Phase 2 — parallel pair of the next two T1 nodes
  if (cursor + 1 < racePool.length && budgetOk()) {
    const winner = await arm([racePool[cursor], racePool[cursor + 1]], "t1");
    cursor += 2;
    const resp = respond(winner);
    if (resp) {
      await finalizeWinner(winner);
      return resp;
    }
  }

  // Phase 3 — remaining T1, one node at a time
  while (cursor < racePool.length) {
    if (!budgetOk()) break;
    const winner = await arm([racePool[cursor]], "t1");
    cursor += 1;
    const resp = respond(winner);
    if (resp) {
      await finalizeWinner(winner);
      return resp;
    }
  }

  // Phase 3b — T2 pool, one node at a time
  for (const node of t2Nodes) {
    if (!budgetOk()) break;
    const winner = await arm([node], "t2");
    const resp = respond(winner);
    if (resp) {
      await finalizeWinner(winner);
      return resp;
    }
    log("error", "t2_failed", { node: node.id, attemptMs: elapsed() });
  }

  // ── Step: exhausted — 302 to original poster, never a blank image ──────
  const wallMs = elapsed();
  log("error", "chain_exhausted", {
    colo,
    format,
    attempts: attemptsMade,
    wallMs,
  });

  // Stop everything still in flight and log any settled attempts as losers.
  winnerKey = "none";
  abortPool(null);
  await Promise.allSettled([...pool.values()].map((r) => r.promise));
  pool.forEach((rec) => logAttemptRecord(rec));
  reportEmbed();

  if (fallbackImageUrl || posterUrl) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: fallbackImageUrl || posterUrl,
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
