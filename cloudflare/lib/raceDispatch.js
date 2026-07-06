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
//
// fleetBridge.reportBatch is still the DO feed for routing decisions (EMA
// score, failing/stressed, dynamic concurrency). It is NOT the analytics
// source anymore — RASTER_METRICS direct writes are.

import { geoOrderNodes, COLO_REGION } from "./geoRouting.js";
import { tryNode } from "./nodeAttempt.js";
import { embedPoster } from "./embedding.js";
import { logRequest, logAttempt } from "./metricsWriter.js";

const GROUP_SIZE_ESCALATED = 2;
const HARD_WALL_MS = 5_000;

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
  const { t2TimeoutMs, posterEmbedTimeoutMs, maxWallTimeMs } = settings;
  const tWall0 = Date.now();
  const payloadKb = Math.round(new Blob([svgText]).size / 1024);
  let attemptsMade = 0;
  const attemptLog = []; // flushed once at the end, to the FleetHealth DO only

  const elapsed = () => Date.now() - tWall0;
  const timedOut = () => elapsed() >= maxWallTimeMs;

  // Analytics + DO health reporting must never be able to break the actual
  // image response — both are wrapped so a thrown error here is swallowed.
  function reportAttempt(nodeId, ok, ms, isWinner, extra) {
    attemptLog.push({ nodeId, ok, ms, isWinner });
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
  function flushHealthReport() {
    try {
      bridge.reportBatch(env, ctx, attemptLog);
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
  const ordered = geoOrderNodes(colo, t1Nodes, health);
  const racePool = [...ordered];
  if (!racePool.some((n) => n.id === "wsrv")) {
    const wsrvNode = t1Nodes.find((n) => n.id === "wsrv");
    if (wsrvNode) racePool.push(wsrvNode);
  }

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

  // ── Step: single-node-first, escalate to pairs on failure ──────────────
  let cursor = 0;
  let groupSize = 1;
  while (cursor < racePool.length) {
    if (Date.now() - tWall0 >= wallDeadline) {
      log("warn", "t1_race_wall_timeout_abort", { elapsed: elapsed() });
      break;
    }
    const remainingBudget = wallDeadline - elapsed();
    if (remainingBudget <= 200) break;

    const group = racePool.slice(cursor, cursor + groupSize);
    const winner = await raceGroup(group, remainingBudget, "t1");
    if (winner.ok) {
      logRequest(env, {
        format,
        inputType,
        colo,
        totalWallMs: elapsed(),
        attemptsMade,
        posterEmbedMs: embedMs,
        payloadKb,
        outcome: "success",
      });
      flushHealthReport();
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
    cursor += group.length;
    groupSize = GROUP_SIZE_ESCALATED;
  }

  // ── Step: T2 extreme fallback ────────────────────────────────────────
  // Bounded by the SAME wallDeadline as T1 (not the larger maxWallTimeMs),
  // so the advertised "5s hard cap" actually caps the end-to-end request
  // instead of T1 being capped at 5s while T2 gets its own separate
  // window up to maxWallTimeMs (7-8s in nodes.config.js).
  for (const node of t2Nodes) {
    if (Date.now() - tWall0 >= wallDeadline) {
      log("warn", "t2_wall_timeout_abort", { elapsed: elapsed() });
      break;
    }
    attemptsMade++;
    const budget = Math.max(500, wallDeadline - elapsed() - 150);
    const nodeTimeout = Math.min(t2TimeoutMs, budget);
    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), nodeTimeout);
    const t0 = Date.now();
    const result = await tryNode(
      node,
      embeddedSvg,
      svgUrl,
      format,
      ac.signal,
      health,
    )
      .catch(() => ({ ok: false, res: null }))
      .finally(() => clearTimeout(tm));
    const attemptMs = Date.now() - t0;
    reportAttempt(node.id, result.ok, attemptMs, result.ok, {
      error: result.error,
      status: result.status,
      inflightAtStart: result.inflightAtStart,
      nodeScore: health.nodeScore(node.id),
      computeMs: result.computeMs,
      lane: "t2",
    });

    if (result.ok) {
      logRequest(env, {
        format,
        inputType,
        colo,
        totalWallMs: elapsed(),
        attemptsMade,
        posterEmbedMs: embedMs,
        payloadKb,
        outcome: "success_t2",
      });
      flushHealthReport();
      return buildImageResp(
        result.res,
        node.id,
        attemptsMade,
        elapsed(),
        embedMs,
        colo,
        health,
      );
    }
    log("error", "t2_failed", { node: node.id, attemptMs });
  }

  // ── Step: exhausted — 302 to original poster, never a blank image ──────
  const wallMs = elapsed();
  log("error", "chain_exhausted", {
    colo,
    format,
    attempts: attemptsMade,
    wallMs,
  });
  logRequest(env, {
    format,
    inputType,
    colo,
    totalWallMs: wallMs,
    attemptsMade,
    posterEmbedMs: embedMs,
    payloadKb,
    outcome: "failure",
  });
  flushHealthReport();

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
