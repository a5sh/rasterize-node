// cloudflare/lib/health.js
//
// Per-isolate node health/error/perf/inflight tracking — the EMA-based
// node score used for routing decisions — plus the FleetHealth Durable
// Object bridge (the cross-isolate scoring signal from the architecture
// notes).
//
// refreshScores/reportOutcome are exported for the DO-authoritative scoring
// integration but are NOT yet called from the dispatch path in this file —
// wiring routing to trust DO state over local per-isolate EMA is a real
// behavioral change (making an isolate that's never personally seen a node
// fail defer to global consensus), tracked separately from this pure
// structural split so it can be reviewed on its own.

export const EMA_ALPHA = 0.2; // smoothing factor — higher = more reactive

export function createHealthState({
  errWindowMs,
  stressThreshold,
  failingThreshold,
}) {
  /** nodeId → { count, windowEnd } */
  const errMap = new Map();
  /** nodeId → current in-flight count */
  const inflightMap = new Map();
  /** nodeId → { emaMs, sampleCount } */
  const perfMap = new Map();

  function recordErr(id) {
    const now = Date.now();
    let e = errMap.get(id) ?? { count: 0, windowEnd: now + errWindowMs };
    if (now > e.windowEnd) e = { count: 0, windowEnd: now + errWindowMs };
    e.count++;
    errMap.set(id, e);
  }
  function recordOk(id) {
    const e = errMap.get(id);
    if (e) e.count = Math.max(0, e.count - 1);
  }
  function errCount(id) {
    const e = errMap.get(id);
    return !e || Date.now() > e.windowEnd ? 0 : e.count;
  }
  function isStressed(id) {
    return errCount(id) >= stressThreshold;
  }
  function isFailing(id) {
    return errCount(id) >= failingThreshold;
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
  function atCapacity(n) {
    return n.concurrencyLimit !== null && inFlight(n.id) >= n.concurrencyLimit;
  }

  function recordPerf(id, ms) {
    const p = perfMap.get(id);
    if (!p) {
      perfMap.set(id, { emaMs: ms, sampleCount: 1 });
    } else {
      p.emaMs = EMA_ALPHA * ms + (1 - EMA_ALPHA) * p.emaMs;
      p.sampleCount += 1;
    }
  }
  function emaMs(id) {
    return perfMap.get(id)?.emaMs ?? 9_999;
  }

  /**
   * Node score — lower is better. Combines EMA response time + error
   * penalty + concurrency penalty. Useful for comparing node performance
   * even without knowing their underlying CPU specs.
   */
  function nodeScore(id) {
    return emaMs(id) + errCount(id) * 500 + inFlight(id) * 80;
  }

  return {
    perfMap,
    recordErr,
    recordOk,
    errCount,
    isStressed,
    isFailing,
    acquireInflight,
    releaseInflight,
    inFlight,
    atCapacity,
    recordPerf,
    emaMs,
    nodeScore,
  };
}

// ── FleetHealth Durable Object bridge ────────────────────────────────────────

const SCORE_CACHE_TTL_MS = 5_000;

export function createFleetHealthBridge() {
  let scoreCache = { data: {}, fetchedAt: 0 };

  async function refreshScores(env) {
    if (Date.now() - scoreCache.fetchedAt < SCORE_CACHE_TTL_MS)
      return scoreCache.data;
    try {
      const id = env.FLEET_HEALTH.idFromName("global");
      const stub = env.FLEET_HEALTH.get(id);
      const res = await stub.fetch("https://fleet-health.internal/scores");
      scoreCache = { data: await res.json(), fetchedAt: Date.now() };
    } catch (_) {
      /* keep stale cache on error */
    }
    return scoreCache.data;
  }

  function reportOutcome(env, ctx, nodeId, ok, ms) {
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

  return { refreshScores, reportOutcome };
}
