// cloudflare/fleetHealth.js
//
// Single source of truth for node health/perf across ALL isolates of Worker B.
// Every isolate still does its own dispatch/racing (that part doesn't need to be
// centralized — only the *scoring signal* does), but instead of keeping private
// _errMap/_perfMap/_inflightMap, isolates report outcomes here (fire-and-forget)
// and read a cached snapshot of scores before choosing node order.
//
// This directly fixes:
//   - routing decisions using a stale/local view of node health
//   - dashboard cron catching an isolate with "No samples yet"
//   - (future) duplicate failing-threshold webhook alerts firing per-isolate
//
// Nodes themselves send nothing here — this only aggregates data the LB
// generates internally while dispatching.

const EMA_ALPHA = 0.2;
const ERR_WINDOW_MS = 60_000;
const FAILING_THRESHOLD = 8;
const STRESSED_THRESHOLD = 3;

export class FleetHealth {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.nodes = new Map(); // nodeId -> { emaMs, samples, errCount, errWindowEnd, wasFailing }
  }

  _get(id) {
    let n = this.nodes.get(id);
    if (!n) {
      n = {
        emaMs: 9999,
        samples: 0,
        errCount: 0,
        errWindowEnd: 0,
        wasFailing: false,
      };
      this.nodes.set(id, n);
    }
    return n;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/report") {
      const { nodeId, ok, ms } = await request.json();
      const n = this._get(nodeId);
      const now = Date.now();

      if (ok) {
        n.emaMs =
          n.samples === 0 ? ms : EMA_ALPHA * ms + (1 - EMA_ALPHA) * n.emaMs;
        n.samples++;
        if (now < n.errWindowEnd) n.errCount = Math.max(0, n.errCount - 1);
      } else {
        if (now > n.errWindowEnd) {
          n.errCount = 0;
          n.errWindowEnd = now + ERR_WINDOW_MS;
        }
        n.errCount++;
      }

      // Edge-triggered state change — this is where a future webhook alert
      // should hook in exactly once, regardless of how many isolates are calling in.
      const isFailingNow = n.errCount >= FAILING_THRESHOLD;
      const transitioned = isFailingNow !== n.wasFailing;
      n.wasFailing = isFailingNow;

      return Response.json({ ok: true, transitioned, isFailingNow });
    }

    if (url.pathname === "/scores") {
      const out = {};
      for (const [id, n] of this.nodes) {
        out[id] = {
          emaMs: Math.round(n.emaMs),
          errCount: n.errCount,
          samples: n.samples,
          stressed: n.errCount >= STRESSED_THRESHOLD,
          failing: n.errCount >= FAILING_THRESHOLD,
        };
      }
      return Response.json(out);
    }

    return new Response("not found", { status: 404 });
  }
}
