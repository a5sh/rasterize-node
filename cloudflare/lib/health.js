// cloudflare/lib/health.js
//
// Local, per-isolate layer is now ONLY for values that must be instantaneous
// within a single race (in-flight admission counting). Everything
// cross-isolate — scores, failing/stressed flags, dynamic concurrency
// ceilings — comes from the FleetHealth DO, cached for SCORE_CACHE_TTL_MS
// per isolate so routing doesn't pay a DO round-trip on every request.

import NODE_CONFIG from "../../assets/nodes.config.js";

const DEFAULT_CONCURRENCY = 4;
const SCORE_CACHE_TTL_MS = 5_000;

function initialHint(id) {
  const n = NODE_CONFIG.nodes.find((x) => x.id === id);
  return n?.initialConcurrencyHint ?? null; // null = unlimited (serverless/CDN)
}
export function createHealthState({ stressThreshold, failingThreshold }) {
  const inflightMap = new Map(); // real-time, local — must stay synchronous
  let snapshot = {}; // last DO /scores snapshot
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

// ── FleetHealth DO bridge ────────────────────────────────────────────────
export function createFleetHealthBridge() {
  let cache = { data: {}, fetchedAt: 0 };

  async function refreshScores(env) {
    if (Date.now() - cache.fetchedAt < SCORE_CACHE_TTL_MS) return cache.data;
    try {
      const id = env.FLEET_HEALTH.idFromName("global");
      const stub = env.FLEET_HEALTH.get(id);
      const res = await stub.fetch("https://fleet-health.internal/scores");
      cache = { data: await res.json(), fetchedAt: Date.now() };
    } catch (_) {
      /* keep stale cache */
    }
    return cache.data;
  }

  /**
   * Fire-and-forget, batched ONCE per incoming request (never across
   * requests — a cross-request setTimeout accumulator would risk the same
   * "Promise will never complete" class of bug documented in batchLoader.js).
   */
  function reportBatch(env, ctx, outcomes) {
    if (!outcomes || outcomes.length === 0) return;
    ctx.waitUntil(
      (async () => {
        try {
          const id = env.FLEET_HEALTH.idFromName("global");
          const stub = env.FLEET_HEALTH.get(id);
          await stub.fetch("https://fleet-health.internal/report-batch", {
            method: "POST",
            body: JSON.stringify({ outcomes }),
          });
        } catch (_) {}
      })(),
    );
  }

  return { refreshScores, reportBatch };
}
