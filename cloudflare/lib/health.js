// cloudflare/lib/health.js
//
// Local, per-isolate layer is now ONLY for values that must be instantaneous
// within a single race (in-flight admission counting + a per-isolate error
// overlay). Everything cross-isolate — scores, failing/stressed flags,
// dynamic concurrency ceilings — comes from the fleet snapshot in
// DASHBOARD_KV ("fleet:snapshot"), written every 15 minutes by
// lib/fleetSync.js, cached for SCORE_CACHE_TTL_MS per isolate so routing
// doesn't pay a KV round-trip on every request.

import NODE_CONFIG from "../../assets/nodes.config.js";

const DEFAULT_CONCURRENCY = 4;
const SCORE_CACHE_TTL_MS = 5_000;

function initialHint(id) {
  const n = NODE_CONFIG.nodes.find((x) => x.id === id);
  return n?.initialConcurrencyHint ?? null; // null = unlimited (serverless/CDN)
}
export function createHealthState({ stressThreshold, failingThreshold }) {
  const inflightMap = new Map(); // real-time, local — must stay synchronous
  let snapshot = {}; // last fleet snapshot (KV, via createKvFleetBridge)
  // Local, per-isolate error overlay — populated synchronously by
  // recordErr()/recordOk() during a race so routing decisions within THIS
  // isolate reflect the current request's outcomes immediately, without
  // waiting for the next DO /scores refresh (SCORE_CACHE_TTL_MS-bounded).
  // The DO remains the cross-isolate source of truth; this overlay is
  // cleared whenever a fresh snapshot merge happens.
  const localErrOverlay = new Map(); // id -> local err count (since last mergeSnapshot)

  function mergeSnapshot(snap) {
    snapshot = snap || {};
    localErrOverlay.clear();
  }

  function recordErr(id) {
    localErrOverlay.set(id, (localErrOverlay.get(id) ?? 0) + 1);
  }
  function recordOk(id) {
    if (localErrOverlay.has(id)) {
      const n = localErrOverlay.get(id) - 1;
      if (n <= 0) localErrOverlay.delete(id);
      else localErrOverlay.set(id, n);
    }
  }

  function acquireInflight(id) {
    inflightMap.set(id, (inflightMap.get(id) ?? 0) + 1);
  }
  function releaseInflight(id) {
    inflightMap.set(id, Math.max(0, (inflightMap.get(id) ?? 0) - 1));
  }
  function inFlight(id) {
    return inflightMap.get(id) ?? 0;
  }

  function limitFor(id) {
    const s = snapshot[id];
    if (s?.concurrencyLimit !== undefined && s.concurrencyLimit !== null)
      return s.concurrencyLimit;
    if (s?.concurrencyLimit === null) return null;
    const hint = initialHint(id);
    return hint === null ? null : (hint ?? DEFAULT_CONCURRENCY);
  }
  function atCapacity(n) {
    const limit = limitFor(n.id);
    return limit !== null && inFlight(n.id) >= limit;
  }

  function emaMs(id) {
    return snapshot[id]?.emaMs ?? 9_999;
  }
function errCount(id) {
    return (snapshot[id]?.errCount ?? 0) + (localErrOverlay.get(id) ?? 0);
  }
  function isStressed(id) {
    if (localErrOverlay.has(id)) return errCount(id) >= stressThreshold;
    return snapshot[id]?.stressed ?? errCount(id) >= stressThreshold;
  }
  function isFailing(id) {
    if (localErrOverlay.has(id)) return errCount(id) >= failingThreshold;
    return snapshot[id]?.failing ?? errCount(id) >= failingThreshold;
  }
  function nodeScore(id) {
    const s = snapshot[id];
    if (s?.score != null && !localErrOverlay.has(id)) return s.score;
    return emaMs(id) + errCount(id) * 500 + inFlight(id) * 80;
  }
  function perfSamples(id) {
    return snapshot[id]?.samples ?? 0;
  }

return {
    mergeSnapshot,
    recordErr,
    recordOk,
    acquireInflight,
    releaseInflight,
    inFlight,
    atCapacity,
    emaMs,
    errCount,
    isStressed,
    isFailing,
    nodeScore,
    perfMap: {
      get: (id) =>
        perfSamples(id)
          ? { emaMs: emaMs(id), sampleCount: perfSamples(id) }
          : undefined,
    },
  };
}

// ── Fleet snapshot bridge (KV-backed; FleetHealth DO removed) ────────────
// Reads the 15-minute cron snapshot from DASHBOARD_KV and serves it to
// raceDispatch once per request (5s per-isolate cache). Routing stats are
// written to Analytics Engine per-attempt by metricsWriter.js, so there is
// nothing to report back — reportBatch is a no-op.
export function createKvFleetBridge() {
  let cache = { data: {}, fetchedAt: 0 };

  async function refreshScores(env) {
    if (Date.now() - cache.fetchedAt < SCORE_CACHE_TTL_MS) return cache.data;
    try {
      const kv = env?.DASHBOARD_KV;
      if (!kv || typeof kv.get !== "function") return cache.data || {};
      const json = await kv.get("fleet:snapshot", "json");
      cache = { data: json || {}, fetchedAt: Date.now() };
    } catch (_) {
      /* keep stale cache */
    }
    return cache.data;
  }

  return { refreshScores };
}
