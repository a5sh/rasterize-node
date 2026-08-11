// cloudflare/lib/raceDispatch.js
//
// v15 — fixes:
//   • ctx/fleetBridge are now real parameters. Previously referenced via
//     `arguments[0].ctx` / `this?.ctx`, both always undefined because
//     worker.js never passed either — every call into fleetBridge threw
//     synchronously before any node was even contacted. Fixed at the call
//     site in worker.js; also defended here with a no-op fallback bridge
//     and try/catch around every analytics/health call so a future wiring
//     mistake degrades to "no health reporting" instead of "no images."
//   • Every node attempt now writes a full-fidelity row straight to
//     RASTER_METRICS via logAttempt() — node, format, type, colo, outcome,
//     error, lane, wasWinner, wall ms, node-reported compute ms, in-flight
//     count, payload size, EMA score at selection. logAttempt existed in
//     metricsWriter.js but nothing called it — that's the actual reason
//     most of routes/analytics.js's per-node queries returned 0 rows, both
//     before and after any DO work.
//   • isWinner is decided once per race group AFTER it settles, not by
//     whichever attempt happened to resolve successfully inside its own
//     promise body (previously `isWinner: result.ok` could tag every
//     successful racer as a winner, not just the one actually returned).
//   • logRequest() removed — the per-request 'req' summary row is written
//     exactly once by Worker A (writeWallTime), so Worker B no longer emits
//     a duplicate datapoint per poster request.
//
// fleetBridge.refreshScores feeds the KV fleet snapshot (written every
// 15 minutes by fleetSync.js from Analytics Engine stats + health polls)
// into the per-isolate health state, cached 5s per isolate. reportBatch is
// a no-op — per-attempt routing analytics go straight to RASTER_METRICS by
// logAttempt(); the snapshot's score/failing/concurrency are derived from
// that same data at cron time.

import { geoOrderNodes } from "./geoRouting.js";
import { tryNode, gzip } from "./nodeAttempt.js";
import { embedPoster } from "./embedding.js";
import { logAttempt } from "./metricsWriter.js";

const HARD_WALL_MS = 5_000;
// Per-attempt ceiling across the fallback ladder: a single hanging node must
// not be allowed to consume the entire wall budget — otherwise one timeout
// would make every later node unreachable. Healthy nodes finish in ~100-500ms,
// so 1.5s is generous while still guaranteeing the chain can walk all nodes.
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
  health,
) {
  const h = new Headers(upstream.headers);
  const geoRegion = (colo && COLO_REGION[colo.toUpperCase()]) || "UNKNOWN";
  h.set("Access-Control-Allow-Origin", "*");
  h.set("X-Raster-Source", nodeId);
  h.set("X-Attempt-Count", String(attemptCount));
  h.set("X-Wall-Ms", String(wallMs));
  h.set("X-Poster-Embed-Ms", String(embedMs));
  h.set("X-Node-Score", String(Math.round(health.nodeScore(nodeId))));
  h.set("X-Geo-Preferred", geoRegion);
  h.set("X-CF-Colo", colo || "");
  h.set("X-LB-Version", "cf-v15");
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
  const timedOut = () => elapsed() >= maxWallTimeMs;

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

  const { svg: embeddedSvg, embedMs } = await embedPoster(
    svgText,
    posterUrl,
    env,
    posterEmbedTimeoutMs,
    log,
  );

  const wallDeadline = Math.min(maxWallTimeMs, HARD_WALL_MS);
  const ordered = geoOrderNodes(colo, t1Nodes, health, continent);
  const racePool = [...ordered];

  // Compression: build the gzipped payload ONCE per request and reuse it for
  // every POST-body node — the old path re-ran CompressionStream("gzip") on
  // the same ~200-400KB SVG inside every single tryNode() call (4-6 gzips per
  // request). URL-payload nodes (wsrv/Vercel GET) never need it. gzip() is
  // null-safe: on failure each node falls back to a plain-text POST.
  const gzPayload = racePool.some(
    (n) =>
      !n.useUrlPayload &&
      (n.acceptsCompression === "gzip" || n.acceptsCompression === true),
  )
    ? await gzip(embeddedSvg)
    : null;

  async function raceGroup(nodes, budgetMs, lane) {
    const nodeControllers = nodes.map(() => new AbortController());
    let winnerIdx = -1;
    const abortLosers = (exceptIdx) => {
      nodeControllers.forEach((c, i) => {
        if (i !== exceptIdx && !c.signal.aborted) c.abort();
      });
    };
    const timer = setTimeout(() => abortLosers(winnerIdx), budgetMs);

    const promises = nodes.map(async (node, idx) => {
      if (health.atCapacity(node)) {
        return { ok: false, node, skipped: true, idx };
      }
      attemptsMade++;
      const t0 = Date.now();
      const result = await tryNode(
        node,
        embeddedSvg,
        svgUrl,
        format,
        nodeControllers[idx].signal,
        health,
        gzPayload,
      );
      const attemptMs = Date.now() - t0;

      if (!result.ok && result.error !== "timeout") {
        log("warn", "t1_failed", {
          node: node.id,
          error: result.error,
          attemptMs,
        });
      }
      return { ...result, node, attemptMs, idx };
    });

    let winner;
    try {
      winner = await new Promise((resolve) => {
        let remaining = promises.length;
        if (remaining === 0) resolve({ ok: false });
        promises.forEach((p) =>
          p
            .then((r) => {
              if (r.ok && winnerIdx === -1) {
                winnerIdx = r.idx;
                abortLosers(r.idx);
                resolve(r);
              } else {
                remaining--;
                if (remaining === 0) resolve(r);
              }
            })
            .catch((err) => {
              remaining--;
              log("warn", "race_promise_settle_error", {
                reason: err?.message || String(err),
              });
              if (remaining === 0) resolve({ ok: false });
            }),
        );
      });
    } finally {
      clearTimeout(timer);
    }

    // Now that the true winner is known, log every settled attempt once.
    const settled = await Promise.allSettled(promises);
    settled.forEach((s) => {
      if (s.status !== "fulfilled" || s.value?.skipped) return;
      const r = s.value;
      const isWinner = r.ok && r.idx === winnerIdx;
      reportAttempt(r.node.id, r.ok, r.attemptMs, isWinner, {
        error: r.error,
        status: r.status,
        inflightAtStart: r.inflightAtStart,
        nodeScore: health.nodeScore(r.node.id),
        computeMs: r.computeMs,
        lane,
      });
    });

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
    if (winner.ok) {
      return buildImageResp(
        winner.res,
        winner.node.id,
        attemptsMade,
        elapsed(),
        embedMs,
        colo,
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
    if (resp) return resp;
  }

  // Phase 2 — parallel pair of the next two T1 nodes
  if (cursor + 1 < racePool.length && budgetOk()) {
    const winner = await arm([racePool[cursor], racePool[cursor + 1]], "t1");
    cursor += 2;
    const resp = respond(winner);
    if (resp) return resp;
  }

  // Phase 3 — remaining T1, one node at a time
  while (cursor < racePool.length) {
    if (!budgetOk()) break;
    const winner = await arm([racePool[cursor]], "t1");
    cursor += 1;
    const resp = respond(winner);
    if (resp) return resp;
  }

  // Phase 3b — T2 pool, one node at a time
  for (const node of t2Nodes) {
    if (!budgetOk()) break;
    const winner = await arm([node], "t2");
    const resp = respond(winner);
    if (resp) return resp;
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
