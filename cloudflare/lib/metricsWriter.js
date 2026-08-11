// cloudflare/lib/metricsWriter.js
//
// RASTER_METRICS Analytics Engine write helpers. Named metricsWriter (not
// analytics.js) to avoid collision with api/routes/analytics.js, which
// reads this dataset rather than writing it.
//
// ── Analytics schema (RASTER_METRICS) ────────────────────────────────────────
// Per-attempt datapoint (written by logAttempt, one per node dispatch):
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
//   double6 = nodeScore        EMA score at moment of selection (lower = better)
//
// ── CPU performance proxy (useful AE query) ───────────────────────────────────
//   Serial-equivalent CPU time ≈ double1 * (1 + double4)
//   SELECT blob1 AS node,
//          avg(double1) AS avg_ms,
//          avg(double1 * (1 + double4)) AS cpu_proxy_ms,
//          count() AS samples
//   FROM raster_metrics
//   WHERE timestamp > now() - INTERVAL '7' DAY
//     AND blob5 = 'success' AND blob1 != 'req'
//   GROUP BY node ORDER BY cpu_proxy_ms ASC
// double7 = computeMs — node-self-reported render time (X-Render-Ms header).
// 0 when the node doesn't report one (wsrv.nl). wall_ms - compute_ms is a
// decent proxy for network/queue overhead per node.
export function logAttempt(
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
    nodeScore = 0,
    computeMs = 0,
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
        computeMs,
      ],
      indexes: [nodeId],
    });
  } catch (_) {}
}
// NOTE: the per-request summary row (blob1 = 'req') is written exactly ONCE
// per request by Worker A (handlers/posterAnalytics.js writeWallTime) — it
// covers every path, including binding-unavailable and SVG-generation
// failures that never reach Worker B. logRequest() was removed here to
// avoid a duplicate datapoint per raster request.

// ── Embed analytics (written by raceDispatch.js, one row per request) ───────
//   blob1 = 'embed'
//   blob2 = format             'png' | 'jpg' | 'webp'
//   blob3 = inputType          'movie' | 'tv' | 'anime'
//   blob4 = colo               CF datacenter code
//   blob5 = outcome            'success' | 'failure'
//   blob6 = errorReason        '' on success, 'http_NNN' | 'throw:...' on fail
//   blob7 = cache              'hit' | 'miss' (poster-asset cache)
//   double1 = embedMs          fetch + base64 + splice time (0 on cache hit)
//   double2 = gzipMs           time spent gzipping the embedded SVG
//   double3 = payloadBytes     embedded SVG length in bytes
export function logEmbed(
  env,
  {
    format,
    inputType,
    colo,
    outcome,
    errorReason = "",
    cache,
    embedMs = 0,
    gzipMs = 0,
    payloadBytes = 0,
  },
) {
  try {
    env?.RASTER_METRICS?.writeDataPoint({
      blobs: [
        "embed",
        format,
        inputType,
        colo,
        outcome,
        errorReason,
        cache,
        "",
      ],
      doubles: [embedMs, gzipMs, payloadBytes, 0, 0, 0, 0],
      indexes: ["embed"],
    });
  } catch (_) {}
}
