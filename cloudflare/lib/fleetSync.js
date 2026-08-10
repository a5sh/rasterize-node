// cloudflare/lib/fleetSync.js
//
// KV-based replacement for the deleted FleetHealth Durable Object.
//
// Runs on the Worker's scheduled() trigger every 15 minutes and:
//   1. Queries RASTER_METRICS (Analytics Engine HTTP SQL API — the only
//      in-Worker path; there is no binding-level query API) for per-node
//      stats over the last 15 minutes: samples, avg attempt ms, wins,
//      failures. Rolled into each node's EMA score. The query runs
//      HOURLY (ANALYTICS_INTERVAL_MS); on cooldown ticks the last known
//      window stats and errCount are carried forward so flags don't flap.
//   2. Health-polls every /health-capable node that hasn't reported in
//      STALE_REPORT_MS (capped at MAX_CONCURRENT_HEALTH_FETCHES fetches).
//   3. Ingests `fleet:heartbeat:*` KV keys written by POST /report
//      (legacy serverlessReporter beacons from Vercel/Netlify).
//   4. Recomputes errCount/score/stressed/failing, adjusts dynamic
//      concurrency ceilings, fires rate-limited Discord alerts on
//      failing/recovered/down/back-online transitions.
//   5. Persists the snapshot to DASHBOARD_KV under "fleet:snapshot"
//      (meta under "fleet:meta") and refreshes the Discord dashboard
//      every 15 minutes with the latest /health details plus the
//      (hourly-refreshed) analytics window summary.
//
// The snapshot row shape MUST keep the keys consumeHealthState()'s
// mergeSnapshot() relies on: emaMs, errCount, score, stressed, failing,
// status, concurrencyLimit, activeJobs, samples. Extra keys are fine.

import NODE_CONFIG from "../../assets/nodes.config.js";
import { BRAND, actionRowLinkButtons } from "./embedBrand.js";

const EMA_ALPHA = 0.2;
const FAILING_THRESHOLD = 8;
const STRESSED_THRESHOLD = 3;

const WINDOW_MINUTES = 15; // AE query window (analytics rows shown on the dashboard)
const DASHBOARD_INTERVAL_MS = 15 * 60_000; // health/status embed refresh
const ANALYTICS_INTERVAL_MS = 60 * 60_000; // Analytics Engine query cadence
const STALE_REPORT_MS = 90_000;
const HEALTH_FETCH_TIMEOUT_MS = 4_000;
const MAX_CONCURRENT_HEALTH_FETCHES = 5; // Workers cap: 6 outgoing connections/request
const AE_QUERY_TIMEOUT_MS = 20_000;

const CONCURRENCY_MIN = 1;
const CONCURRENCY_MAX = 24;

const ALERT_MAX_PER_WINDOW = 3; // per 5 min
const ALERT_MIN_GAP_MS = 10_000;

const nodeMeta = (id) => NODE_CONFIG.nodes.find((n) => n.id === id) || null;

// secrets_store_secrets bindings (CF_ACCOUNT_ID/CF_API_TOKEN) arrive as
// plain strings; tolerate a .get()-style binding defensively.
async function resolveSecret(binding) {
  if (!binding) return null;
  if (typeof binding === "string") return binding;
  if (typeof binding.get === "function") {
    try {
      return await binding.get();
    } catch {
      return null;
    }
  }
  return null;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

function adjustConcurrency(current, healthy) {
  const cur = current ?? 4;
  return healthy
    ? Math.min(CONCURRENCY_MAX, cur + 1)
    : Math.max(CONCURRENCY_MIN, Math.floor(cur / 2));
}

// ── Step 2: per-node stats for the last 15 min from Analytics Engine ──────
async function queryAeWindow(env, log) {
  const accountId = await resolveSecret(env?.CF_ACCOUNT_ID);
  const apiToken = await resolveSecret(env?.CF_API_TOKEN);
  if (!accountId || !apiToken) {
    log("warn", "fleet_sync_no_ae_creds", {
      account: !!accountId,
      token: !!apiToken,
    });
    return null;
  }
  const sql = [
    "SELECT index1 AS node_id,",
    "  count() AS samples,",
    "  avg(double1) AS avg_ms,",
    "  sum(double3) AS wins,",
    "  countIf(blob5 = 'failure') AS errors",
    `FROM raster_metrics`,
    `WHERE blob1 != 'req' AND timestamp >= NOW() - INTERVAL '${WINDOW_MINUTES}' MINUTE`,
    "GROUP BY index1",
  ].join("\n");
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "text/plain",
        },
        body: sql,
        signal: AbortSignal.timeout(AE_QUERY_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("warn", "fleet_sync_ae_http", { status: res.status, body: body.slice(0, 200) });
      return null;
    }
    const json = await res.json().catch(() => null);
    if (!json || !Array.isArray(json.data)) {
      log("warn", "fleet_sync_ae_bad_payload", { rows: json?.rows });
      return null;
    }
    const out = {};
    for (const row of json.data) {
      const id = String(row.node_id);
      out[id] = {
        samples: Number(row.samples ?? 0),
        avgMs: Number(row.avg_ms ?? 0),
        wins: Number(row.wins ?? 0),
        errors: Number(row.errors ?? 0),
      };
    }
    return out;
  } catch (e) {
    log("warn", "fleet_sync_ae_threw", { reason: e?.message });
    return null;
  }
}

// ── Step 3: health-poll stale nodes (4s timeout, 5 concurrent) ────────────
async function pollNodesHealth(allNodes, prev, now, log) {
  const targets = allNodes.filter(
    (n) =>
      n.supportsHealthCheck &&
      now - (prev[n.id]?.last_seen_at || 0) > STALE_REPORT_MS,
  );
  const out = {};
  if (targets.length === 0) return out;
  await mapWithConcurrency(targets, MAX_CONCURRENT_HEALTH_FETCHES, async (n) => {
    try {
      const res = await fetch(`${n.baseUrl}/health`, {
        signal: AbortSignal.timeout(HEALTH_FETCH_TIMEOUT_MS),
        headers: { "User-Agent": "SpicyDevs-LB/14.0" },
      });
      if (!res.ok) {
        out[n.id] = { ok: false, h: null };
        return;
      }
      const h = await res.json().catch(() => ({}));
      out[n.id] = { ok: true, h };
    } catch (_) {
      out[n.id] = { ok: false, h: null };
    }
  });
  return out;
}

// ── Step 4: ingest self-report beacons buffered by POST /report ───────────
async function collectHeartbeats(kv, log) {
  const out = {};
  try {
    const list = await kv.list({ prefix: "fleet:heartbeat:" });
    for (const k of list.keys) {
      try {
        const raw = await kv.get(k.name, "json");
        if (!raw) continue;
        const nodeId = raw.node || "";
        if (!nodeId) continue;
        const snap = raw.snapshot || {};
        out[nodeId] = {
          at: Number(raw.at) || Date.now(),
          activeJobs: Number(raw.activeJobs ?? snap.activeJobs ?? 0),
          queuedJobs: Number(raw.queuedJobs ?? snap.queuedJobs ?? 0),
          avgMs:
            raw.type === "metrics" && snap.jobDuration?.avg != null
              ? Number(snap.jobDuration.avg)
              : null,
          requests: Number(snap.requests ?? 0),
          errors: Number(snap.errors ?? 0),
        };
        await kv.delete(k.name).catch(() => {});
      } catch (_) {
        /* skip malformed heartbeat */
      }
    }
  } catch (e) {
    log("warn", "fleet_sync_heartbeat_list_failed", { reason: e?.message });
  }
  return out;
}

// ── Step 5: build one node's row from AE + heartbeat + health poll ────────
function buildRow(n, prevRow, ae, poll, hb, now) {
  const prev = prevRow || {};
  const row = {
    emaMs: prev.emaMs ?? 9_999,
    errCount: 0,
    score: prev.score ?? 9_999,
    stressed: false,
    failing: false,
    status: prev.status ?? "unknown",
    concurrencyLimit:
      prev.concurrencyLimit !== undefined
        ? prev.concurrencyLimit
        : (n.concurrencyLimit ?? null),
    activeJobs: prev.activeJobs ?? 0,
    queuedJobs: prev.queuedJobs ?? 0,
    samples: prev.samples ?? 0,
    first_seen_at: prev.first_seen_at ?? now,
    last_seen_at: prev.last_seen_at ?? 0,
    down_since: prev.down_since ?? 0,
    total_requests: prev.total_requests ?? 0,
    total_success: prev.total_success ?? 0,
    total_failure: prev.total_failure ?? 0,
    total_wins: prev.total_wins ?? 0,
    self_reports: prev.self_reports ?? 0,
    health: prev.health ?? null,
    lastSyncMs: now,
  };

  // AE window: errCount is "failures in the last 15 min". The AE query
  // only runs hourly (ANALYTICS_INTERVAL_MS); on cooldown ticks (ae ===
  // null) carry the last known errCount/window forward so stressed and
  // failing flags don't flap between queries.
  if (ae) {
    row.errCount = ae.errors ?? 0;
    row.window = {
      samples: ae.samples ?? 0,
      errors: ae.errors ?? 0,
      wins: ae.wins ?? 0,
      avgMs: Math.round(ae.avgMs ?? 0),
      at: now,
    };
  } else {
    row.errCount = prev.errCount ?? 0;
    row.window = prev.window ?? null;
  }
  if (ae && ae.samples > 0) {
    if (prev.samples > 0 && prev.emaMs != null && prev.emaMs !== 9_999) {
      row.emaMs = EMA_ALPHA * ae.avgMs + (1 - EMA_ALPHA) * prev.emaMs;
    } else {
      row.emaMs = ae.avgMs;
    }
    row.samples = (prev.samples ?? 0) + ae.samples;
    row.total_requests = (prev.total_requests ?? 0) + ae.samples;
    row.total_wins = (prev.total_wins ?? 0) + ae.wins;
    row.total_failure = (prev.total_failure ?? 0) + ae.errors;
    row.total_success = (prev.total_success ?? 0) + (ae.samples - ae.errors);
  }

  // Self-report heartbeat is authoritative for liveness (serverless nodes
  // whose domain-root /health is not pollable).
  if (hb) {
    row.status = "online";
    row.last_seen_at = Math.max(row.last_seen_at, hb.at);
    row.down_since = 0;
    row.self_reports = (row.self_reports ?? 0) + 1;
    row.activeJobs = hb.activeJobs ?? row.activeJobs;
    row.queuedJobs = hb.queuedJobs ?? row.queuedJobs;
    if (hb.avgMs != null && hb.requests > 0) {
      row.emaMs =
        row.samples === 0
          ? hb.avgMs
          : EMA_ALPHA * hb.avgMs + (1 - EMA_ALPHA) * row.emaMs;
      row.samples += hb.requests;
    }
  }

  // Health poll only ran for stale nodes; oldest source wins for status.
  if (poll) {
    if (poll.ok) {
      row.status = "online";
      row.last_seen_at = now;
      row.down_since = 0;
      if (poll.h) {
        row.activeJobs = poll.h.activeJobs ?? row.activeJobs;
      row.queuedJobs = poll.h.queuedJobs ?? row.queuedJobs;
      // Curated /health payload for the dashboard — covers both shapes:
      // VPS nodes (workerCount/pendingRespawns/maxConcurrent/uptime) and
      // serverless nodes (fontReady/iconCache).
      row.health = {
        version: poll.h.version ?? null,
        workerCount: poll.h.workerCount ?? null,
        pendingRespawns: poll.h.pendingRespawns ?? null,
        maxConcurrent: poll.h.maxConcurrent ?? null,
        uptime: poll.h.uptime ?? null,
        fontReady: poll.h.fontReady ?? null,
        iconCount: poll.h.iconCache?.iconCount ?? null,
        iconAgeMs: poll.h.iconCache?.ageMs ?? null,
        at: now,
      };
    }
    } else if (row.status !== "offline") {
      row.status = "offline";
      row.down_since = prev.down_since || now;
    }
  }

  return row;
}

// ── Rate-limited alerts (max 3 per 5 min, 10s min gap) ─────────────────────
function canAlert(meta, now) {
  let count = Number(meta.alertCount || 0);
  let windowEnd = Number(meta.alertWindowEnd || 0);
  const lastAlert = Number(meta.lastAlert || 0);
  if (now > windowEnd) {
    count = 0;
    windowEnd = now + 5 * 60_000;
  }
  if (count >= ALERT_MAX_PER_WINDOW) return false;
  if (now - lastAlert < ALERT_MIN_GAP_MS) return false;
  meta.alertCount = count + 1;
  meta.alertWindowEnd = windowEnd;
  meta.lastAlert = now;
  return true;
}

async function tryAlert(env, log, meta, nodeId, kind, now) {
  const url = env?.ALERTS_WEBHOOK_URL || env?.DISCORD_WEBHOOK_URL;
  if (!url || !canAlert(meta, now)) return;
  const label = nodeMeta(nodeId)?.label || nodeId;
  const copy = {
    failing: {
      title: "🚨 Node Failing",
      color: 0xf87171,
      desc: `**${label}** crossed the failing error threshold.`,
    },
    recovered_errors: {
      title: "✅ Node Recovered",
      color: 0x4ade80,
      desc: `**${label}** dropped back below the failing threshold.`,
    },
    down: {
      title: "🔴 Node Down",
      color: 0xdc2626,
      desc: `**${label}** is unreachable (health check failed).`,
    },
    recovered_down: {
      title: "🟢 Node Back Online",
      color: 0x22c55e,
      desc: `**${label}** is reachable again.`,
    },
  }[kind];
  if (!copy) return;
  const node = nodeMeta(nodeId);
  const tier = node?.specs?.tier === 2 ? "T2 Fallback" : "T1 Primary";
  const poolStr = `${tier}${node?.region ? ` · ${node.region}` : ""}`;
  try {
    const res = await fetch(`${url}?with_components=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "Posterium Alerts",
        avatar_url: BRAND.appIcon,
        embeds: [
          {
            title: copy.title,
            description: copy.desc,
            color: copy.color,
            thumbnail: { url: BRAND.appIcon },
            fields: [
              { name: "Node", value: label, inline: true },
              { name: "Pool", value: poolStr, inline: true },
            ],
            footer: { text: nodeId },
            timestamp: new Date(now).toISOString(),
          },
        ],
        // Link-button Action Row — non-interactive components, webhook-compatible.
        components: actionRowLinkButtons(),
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) log("warn", "fleet_alert_http", { kind, status: res.status });
  } catch (e) {
    log("warn", "fleet_alert_threw", { kind, reason: e?.message });
  }
}

// ── Main cron entry ────────────────────────────────────────────────────────
export async function runFleetSync(env, log, { t1Nodes, t2Nodes } = {}) {
  const allNodes = [...(t1Nodes || []), ...(t2Nodes || [])];
  const kv = env?.DASHBOARD_KV;
  if (!kv) {
    log("error", "fleet_sync_no_kv", {});
    return;
  }
  const now = Date.now();

  const prev = (await kv.get("fleet:snapshot", "json").catch(() => null)) || {};
  const meta = (await kv.get("fleet:meta", "json").catch(() => null)) || {};

  // AE query is HOURLY — health polls + heartbeat collection stay on the
  // 15-min cadence. The dashboard embed reflects both: fresh /health
  // details every tick, analytics window frozen between hourly queries.
  const lastAnalyticsAt = Number(meta.lastAnalyticsAt || 0) || 0;
  const analyticsDue = now - lastAnalyticsAt >= ANALYTICS_INTERVAL_MS;
  let aeStats = null;
  if (analyticsDue) {
    aeStats = await queryAeWindow(env, log);
    if (aeStats) meta.lastAnalyticsAt = now; // only advance on success
  }

  const heartbeats = await collectHeartbeats(kv, log);
  const polls = await pollNodesHealth(allNodes, prev, now, log);

  // Per-node row build
  const rows = {};
  for (const n of allNodes) {
    rows[n.id] = buildRow(
      n,
      prev[n.id],
      aeStats?.[n.id] || null,
      polls[n.id] || null,
      heartbeats[n.id] || null,
      now,
    );
  }
  // Carry forward rows for nodes no longer in the active pool
  for (const [id, r] of Object.entries(prev)) {
    if (!rows[id]) rows[id] = r;
  }

  // Dynamic concurrency ceilings (healthy → +1, erroring → halve)
  for (const n of allNodes) {
    const r = rows[n.id];
    if (r.concurrencyLimit == null) continue;
    const healthy = r.errCount === 0;
    const next = adjustConcurrency(r.concurrencyLimit, healthy);
    if (next !== r.concurrencyLimit) {
      log("info", "fleet_concurrency", {
        nodeId: n.id,
        from: r.concurrencyLimit,
        to: next,
      });
      r.concurrencyLimit = next;
    }
  }

  // Score + flags (after concurrency settles)
  for (const n of allNodes) {
    const r = rows[n.id];
    const inflightPenalty = r.concurrencyLimit
      ? (r.activeJobs / r.concurrencyLimit) * 80
      : 0;
    r.score = r.emaMs + r.errCount * 500 + inflightPenalty;
    r.stressed = r.errCount >= STRESSED_THRESHOLD;
    r.failing = r.errCount >= FAILING_THRESHOLD;
  }

  // Transition alerts
  for (const n of allNodes) {
    const r = rows[n.id];
    const p = prev[n.id];
    if (!p) continue; // first sighting — no transition
    const kinds = [];
    if (!p.failing && r.failing) kinds.push("failing");
    else if (p.failing && !r.failing) kinds.push("recovered_errors");
    if (p.status !== "offline" && r.status === "offline") kinds.push("down");
    if (p.status === "offline" && r.status === "online")
      kinds.push("recovered_down");
    for (const kind of kinds) await tryAlert(env, log, meta, n.id, kind, now);
  }

  // Dashboard refresh every 15 minutes (reads the fresh snapshot only)
  const lastDash = Number(meta.lastDashboardUpdate || 0) || 0;
  if (now - lastDash >= DASHBOARD_INTERVAL_MS && env.DISCORD_WEBHOOK_URL) {
    const { updateDashboard } = await import("./dashboard.js");
    try {
      await updateDashboard(env, rows, log, { t1Nodes, t2Nodes });
      meta.lastDashboardUpdate = now;
      await kv.put("dashboards:last_update", String(now)).catch(() => {});
    } catch (e) {
      log("warn", "fleet_dashboard_failed", { reason: e?.message });
    }
  }

  await kv.put("fleet:snapshot", JSON.stringify(rows)).catch(() => {});
  await kv.put("fleet:meta", JSON.stringify(meta)).catch(() => {});
  log("info", "fleet_sync_done", {
    nodes: Object.keys(rows).length,
    aeWindows: Object.keys(aeStats || {}).length,
    analytics: analyticsDue ? "queried" : "cooldown",
    polled: Object.keys(polls).length,
    heartbeats: Object.keys(heartbeats).length,
    at: new Date(now).toISOString(),
  });
}