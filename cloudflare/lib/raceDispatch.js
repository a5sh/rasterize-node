// cloudflare/lib/raceDispatch.js
//
// Core distributed-render orchestration: T1 pair-racing (2 nodes at a time,
// with wsrv.nl guaranteed present in the pool as a fallback option), a 5s
// hard wall-time budget, T2 extreme fallback on total exhaustion, and the
// final "never return a blank image — 302 to the original poster" path.
//
// RACE-SAFETY NOTE — one AbortController PER RACER, not one shared per
// pair. Sharing a single controller meant that aborting the loser on a win
// also tore down the WINNER's still-streaming response body (both racers
// were listening on the same signal), which surfaced as an uncaught
// AbortError one hop up in the rasterize worker logs ("outcome: exception"
// despite a valid response already having been selected). Each racer gets
// its own controller; on a win, every OTHER racer's controller is aborted,
// never the winner's.

import { geoOrderNodes, COLO_REGION } from "./geoRouting.js";
import { tryNode } from "./nodeAttempt.js";
import { embedPoster } from "./embedding.js";
import { logAttempt, logRequest } from "./metricsWriter.js";

const GROUP_SIZE = 2;
const HARD_WALL_MS = 5_000;

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
  h.set("X-Score", String(Math.round(health.nodeScore(nodeId)))); // alias for debugging
  h.set("X-Geo-Preferred", geoRegion);
  h.set("X-CF-Colo", colo || "");
  h.set("X-LB-Version", "cf-v13");
  h.set("Cache-Control", "public, max-age=172800");
  h.set(
    "Access-Control-Expose-Headers",
    "X-Raster-Source,X-Attempt-Count,X-Wall-Ms,X-Poster-Embed-Ms,X-Node-Score,X-Score,X-Geo-Preferred,X-CF-Colo,X-LB-Version",
  );
  return new Response(upstream.body, { status: 200, headers: h });
}

/**
 * @param {object} opts
 * @param {string} opts.svgText
 * @param {string|null} opts.svgUrl
 * @param {string} opts.format
 * @param {string|null} opts.colo
 * @param {string|null} opts.fallbackImageUrl
 * @param {string|null} opts.posterUrl
 * @param {string} opts.inputType
 * @param {object} opts.env
 * @param {Array} opts.t1Nodes
 * @param {Array} opts.t2Nodes
 * @param {object} opts.settings - { t2TimeoutMs, posterEmbedTimeoutMs, maxWallTimeMs }
 * @param {object} opts.health - createHealthState() instance
 * @param {function} opts.log
 * @returns {Promise<Response>}
 */
export async function distributedRender({
  svgText,
  svgUrl,
  format,
  colo,
  fallbackImageUrl,
  posterUrl,
  inputType,
  env,
  t1Nodes,
  t2Nodes,
  settings,
  health,
  log,
}) {
  const { t2TimeoutMs, posterEmbedTimeoutMs, maxWallTimeMs } = settings;
  const tWall0 = Date.now();
  const payloadKb = Math.round(new Blob([svgText]).size / 1024);
  let attemptsMade = 0;

  const elapsed = () => Date.now() - tWall0;
  const timedOut = () => elapsed() >= maxWallTimeMs;

  // Step 1: Embed poster once in this worker
  const {
    svg: embeddedSvg,
    embedMs,
    embedded,
  } = await embedPoster(svgText, posterUrl, env, posterEmbedTimeoutMs, log);

  log("info", "render_start", {
    colo,
    format,
    inputType,
    payloadKb,
    embedMs,
    embedded,
  });

  // Step 2: T1 nodes with pair-racing concurrency
  const wallDeadline = Math.min(maxWallTimeMs, HARD_WALL_MS);
  const ordered = geoOrderNodes(colo, t1Nodes, health);

  // Ensure wsrv is present as a fallback option within the pool if not already
  const racePool = [...ordered];
  if (!racePool.some((n) => n.id === "wsrv")) {
    const wsrvNode = t1Nodes.find((n) => n.id === "wsrv");
    if (wsrvNode) racePool.push(wsrvNode);
  }

  async function raceGroup(nodes, budgetMs) {
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
        log("info", "t1_skip_capacity", {
          node: node.id,
          inflight: health.inFlight(node.id),
        });
        logAttempt(env, {
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
          inflightCount: health.inFlight(node.id),
          payloadKb,
        });
        return { ok: false, node };
      }

      attemptsMade++;
      // Capture this racer's own attempt number NOW — both racers in a
      // pair increment attemptsMade synchronously before either awaits, so
      // reading the shared counter later (at log time) would make both
      // racers' logs report the same final value.
      const myAttemptNum = attemptsMade;
      const scoreAtSelection = Math.round(health.nodeScore(node.id));
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

      logAttempt(env, {
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
        health.recordPerf(node.id, attemptMs);
        log("info", "t1_success", {
          node: node.id,
          attempt: myAttemptNum,
          attemptMs,
        });
      } else {
        log("warn", "t1_failed", {
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
  }

  // Execute race groups sequentially
  for (let i = 0; i < racePool.length; i += GROUP_SIZE) {
    if (Date.now() - tWall0 >= wallDeadline) {
      log("warn", "t1_race_wall_timeout_abort", { elapsed: elapsed() });
      break;
    }

    const group = racePool.slice(i, i + GROUP_SIZE);
    const remainingBudget = wallDeadline - elapsed();
    if (remainingBudget <= 200) break;

    const winner = await raceGroup(group, remainingBudget);
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
  }

  // Step 3: T2 extreme fallback (only if wall time budget remains)
  for (const node of t2Nodes) {
    if (timedOut()) {
      log("warn", "t2_wall_timeout_abort", { elapsed: elapsed() });
      break;
    }

    attemptsMade++;
    const budget = Math.max(1_000, maxWallTimeMs - elapsed() - 150);
    const nodeTimeout = Math.min(t2TimeoutMs, budget);

    log("warn", "t2_attempt", {
      node: node.id,
      reason: "all_t1_failed",
      timeout: nodeTimeout,
    });

    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), nodeTimeout);
    const t0 = Date.now();
    const { ok, res, error, status, inflightAtStart } = await tryNode(
      node,
      embeddedSvg,
      svgUrl,
      format,
      ac.signal,
      health,
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

    logAttempt(env, {
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
      health.recordPerf(node.id, attemptMs);
      log("info", "t2_success", { node: node.id, attemptMs });
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
      return buildImageResp(
        res,
        node.id,
        attemptsMade,
        elapsed(),
        embedMs,
        colo,
        health,
      );
    }

    log("error", "t2_failed", { node: node.id, error, attemptMs });
  }

  // Step 4: All exhausted — 302 to the ORIGINAL poster, never a blank image
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
