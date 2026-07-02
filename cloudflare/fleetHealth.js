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

// AFTER — rate-limit guard added, mirroring vps/discord.js's proven pattern
// (max 3 alerts / 5 min, min 10s gap), so a flapping node can't spam the
// alerts channel during a real incident.
export class FleetHealth {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.nodes = new Map(); // nodeId -> { emaMs, samples, errCount, errWindowEnd, wasFailing }
    this._alertCount = 0;
    this._alertWindowEnd = 0;
    this._lastAlert = 0;
  }

  _canAlert() {
    const now = Date.now();
    if (now > this._alertWindowEnd) {
      this._alertCount = 0;
      this._alertWindowEnd = now + 5 * 60_000;
    }
    if (this._alertCount >= 3) return false;
    if (now - this._lastAlert < 10_000) return false;
    return true;
  }

  async _sendAlert(nodeId, isFailingNow) {
    const url = this.env?.ALERTS_WEBHOOK_URL;
    if (!url || !this._canAlert()) return;
    this._alertCount++;
    this._lastAlert = Date.now();
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "Posterium Alerts",
          embeds: [
            {
              title: isFailingNow ? "🚨 Node Failing" : "✅ Node Recovered",
              description: `**${nodeId}** ${isFailingNow ? "crossed the failing error threshold" : "dropped back below the failing threshold"}.`,
              color: isFailingNow ? 0xf87171 : 0x4ade80,
              timestamp: new Date().toISOString(),
            },
          ],
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (_) {
      /* fire-and-forget */
    }
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

      // AFTER — this is the single authoritative place a state transition is
      // detected (the DO serializes all requests, so exactly one report call
      // will observe transitioned===true per edge, regardless of how many
      // isolates are concurrently POSTing outcomes).
      const isFailingNow = n.errCount >= FAILING_THRESHOLD;
      const transitioned = isFailingNow !== n.wasFailing;
      n.wasFailing = isFailingNow;

      if (transitioned) {
        // Fire-and-forget; DO's own I/O context, safe without ctx.waitUntil.
        this._sendAlert(nodeId, isFailingNow).catch(() => {});
      }

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
