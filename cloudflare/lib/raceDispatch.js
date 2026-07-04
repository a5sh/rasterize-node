// cloudflare/lib/raceDispatch.js
//
// v14 — single-node-first dispatch: the first attempt tries exactly ONE node.
// Only after that solo attempt fails does the pool escalate to 2-node racing.
// This roughly halves subrequest fan-out for the common "primary node just
// works" case, while preserving the racing fallback for when it doesn't.
//
// Outcome reporting is collected locally per-request and flushed ONCE to the
// FleetHealth DO at the end (see lib/health.js — never batched across
// requests). Per-attempt Analytics Engine writes are gone; the DO aggregates
// and flushes those itself on its alarm tick.

import { geoOrderNodes, COLO_REGION } from "./geoRouting.js";
import { tryNode } from "./nodeAttempt.js";
import { embedPoster } from "./embedding.js";
import { logRequest } from "./metricsWriter.js";

const GROUP_SIZE_ESCALATED = 2;
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
  h.set("X-Geo-Preferred", geoRegion);
  h.set("X-CF-Colo", colo || "");
  h.set("X-LB-Version", "cf-v14");
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
  t1Nodes,
  t2Nodes,
  settings,
  health,
  fleetBridge,
  log,
}) {
  const { t2TimeoutMs, posterEmbedTimeoutMs, maxWallTimeMs } = settings;
  const tWall0 = Date.now();
  const payloadKb = Math.round(new Blob([svgText]).size / 1024);
  let attemptsMade = 0;
  const attemptLog = []; // flushed once at the end — see lib/health.js

  const elapsed = () => Date.now() - tWall0;
  const timedOut = () => elapsed() >= maxWallTimeMs;
  const flushAndReturn = (resp) => {
    fleetBridge.reportBatch(env, this?.ctx ?? env.__ctx, attemptLog);
    return resp;
  };

  // Pull the cross-isolate score/concurrency snapshot ONCE per request
  // (internally cached ~5s in the isolate, so this is usually free).
  health.mergeSnapshot(await fleetBridge.refreshScores(env));

  const {
    svg: embeddedSvg,
    embedMs,
    embedded,
  } = await embedPoster(svgText, posterUrl, env, posterEmbedTimeoutMs, log);

  const wallDeadline = Math.min(maxWallTimeMs, HARD_WALL_MS);
  const ordered = geoOrderNodes(colo, t1Nodes, health);
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
        return { ok: false, node, skipped: true };
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

      attemptLog.push({
        nodeId: node.id,
        ok: result.ok,
        ms: attemptMs,
        isWinner: result.ok,
      });

      if (!result.ok && result.error !== "timeout") {
        log("warn", "t1_failed", {
          node: node.id,
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
                winnerIdx = idx;
                abortLosers(idx);
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
      fleetBridge.reportBatch(env, arguments[0].ctx, attemptLog);
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
    groupSize = GROUP_SIZE_ESCALATED; // escalate after the first failure
  }

  // ── Step: T2 extreme fallback ────────────────────────────────────────
  for (const node of t2Nodes) {
    if (timedOut()) {
      log("warn", "t2_wall_timeout_abort", { elapsed: elapsed() });
      break;
    }
    attemptsMade++;
    const budget = Math.max(1_000, maxWallTimeMs - elapsed() - 150);
    const nodeTimeout = Math.min(t2TimeoutMs, budget);
    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), nodeTimeout);
    const t0 = Date.now();
    const { ok, res } = await tryNode(
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
    attemptLog.push({ nodeId: node.id, ok, ms: attemptMs, isWinner: ok });

    if (ok) {
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
      fleetBridge.reportBatch(env, arguments[0].ctx, attemptLog);
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
  fleetBridge.reportBatch(env, arguments[0].ctx, attemptLog);

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
