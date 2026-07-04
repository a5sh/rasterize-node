// cloudflare/fleetHealth.js
//
// v2 — fixes:
//   • Removed _flush / _flushMetrics entirely. It was writing an aggregated
//     row (blob5='') into RASTER_METRICS once per node per 5-min tick, into
//     the SAME dataset routes/analytics.js's per-attempt queries read —
//     those rows don't match blob5='success'/'failure' so every countIf()
//     silently skipped them, but they still counted in count()/global
//     averages, understating success rates. RASTER_METRICS is now written
//     exclusively, per-attempt, by raceDispatch.js's logAttempt() calls.
//     This DO owns routing state only: EMA score, failing/stressed,
//     dynamic concurrency, uptime, and the Discord dashboard.
//   • _pollHealthChecks now caps concurrent outgoing fetches at 5 instead
//     of Promise.all-ing every health-check-capable node at once. Workers/
//     DOs are limited to 6 simultaneous outgoing connections per request —
//     with 7 health-check nodes and a cold cache (all stale at once) the
//     old code could exceed that.
//   • Added POST /report — accepts the legacy {type:'online'|'metrics', node,
//     snapshot} beacon shape sent by core/serverlessReporter.js (Vercel/
//     Netlify) and adapts it into _recordHeartbeat. Forwarded here from
//     cloudflare/worker.js's new /report route.

import NODE_CONFIG from "../assets/nodes.config.js";

const EMA_ALPHA = 0.2;
const ERR_WINDOW_MS = 60_000;
const FAILING_THRESHOLD = 8;
const STRESSED_THRESHOLD = 3;

const ALARM_INTERVAL_MS = 5 * 60_000;
const DASHBOARD_INTERVAL_MS = 60 * 60_000;
const STALE_REPORT_MS = 90_000;
const HEALTH_FETCH_TIMEOUT_MS = 4_000;
const MAX_CONCURRENT_HEALTH_FETCHES = 5; // DO/Workers limit is 6 simultaneous outgoing connections/request

const CONCURRENCY_MIN = 1;
const CONCURRENCY_MAX = 24;

const ALL_NODES = NODE_CONFIG.nodes;
const nodeMeta = (id) => ALL_NODES.find((n) => n.id === id) || null;

// ── Bounded-concurrency map helper ───────────────────────────────────────
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

export class FleetHealth {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    this.state.blockConcurrencyWhile(async () => {
      this._ensureSchema();
      const alarm = await this.state.storage.getAlarm();
      if (!alarm)
        await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    });
  }

  // ── Schema ────────────────────────────────────────────────────────────
  _ensureSchema() {
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        ema_ms REAL DEFAULT 9999,
        samples INTEGER DEFAULT 0,
        err_count INTEGER DEFAULT 0,
        err_window_end INTEGER DEFAULT 0,
        was_failing INTEGER DEFAULT 0,
        status TEXT DEFAULT 'unknown',
        first_seen_at INTEGER DEFAULT 0,
        last_seen_at INTEGER DEFAULT 0,
        down_since INTEGER DEFAULT 0,
        self_reports INTEGER DEFAULT 0,
        concurrency_limit INTEGER,
        active_jobs INTEGER DEFAULT 0,
        queued_jobs INTEGER DEFAULT 0,
        cpu_load REAL DEFAULT 0,
        mem_pct REAL DEFAULT 0,
        total_requests INTEGER DEFAULT 0,
        total_success INTEGER DEFAULT 0,
        total_failure INTEGER DEFAULT 0,
        total_wins INTEGER DEFAULT 0
      )
    `);
    this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`,
    );
  }

  _getMeta(k, def = null) {
    const r = this.state.storage.sql
      .exec(`SELECT v FROM meta WHERE k=?`, k)
      .toArray();
    return r[0] ? r[0].v : def;
  }
  _setMeta(k, v) {
    this.state.storage.sql.exec(
      `INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`,
      k,
      String(v),
    );
  }

  _row(id) {
    return (
      this.state.storage.sql
        .exec(`SELECT * FROM nodes WHERE id=?`, id)
        .toArray()[0] || null
    );
  }
  _ensureRow(id) {
    let row = this._row(id);
    if (!row) {
      this.state.storage.sql.exec(
        `INSERT INTO nodes (id, first_seen_at) VALUES (?, ?)`,
        id,
        Date.now(),
      );
      row = this._row(id);
    }
    return row;
  }

  _liveErrCount(row) {
    return Date.now() > row.err_window_end ? 0 : row.err_count;
  }
  _score(row) {
    const err = this._liveErrCount(row);
    const inflightPenalty = row.concurrency_limit
      ? (row.active_jobs / row.concurrency_limit) * 80
      : 0;
    return row.ema_ms + err * 500 + inflightPenalty;
  }
  _adjustConcurrency(current, healthy) {
    const cur = current ?? 4;
    return healthy
      ? Math.min(CONCURRENCY_MAX, cur + 1)
      : Math.max(CONCURRENCY_MIN, Math.floor(cur / 2));
  }

  // ── Outcome reporting (from raceDispatch, batched once per request) ────
  // Routing-state only now — see file header. No AE writes here.
  _recordOutcome({ nodeId, ok, ms, isWinner }) {
    const row = this._ensureRow(nodeId);
    const now = Date.now();

    let errCount = this._liveErrCount(row);
    let errWindowEnd = row.err_window_end;
    if (!ok) {
      if (now > errWindowEnd) {
        errCount = 0;
        errWindowEnd = now + ERR_WINDOW_MS;
      }
      errCount++;
    } else if (errCount > 0) {
      errCount--;
    }

    let emaMs = row.ema_ms;
    let samples = row.samples;
    if (ok && ms != null) {
      emaMs = samples === 0 ? ms : EMA_ALPHA * ms + (1 - EMA_ALPHA) * emaMs;
      samples++;
    }

    const isFailingNow = errCount >= FAILING_THRESHOLD;
    const transitioned = isFailingNow !== !!row.was_failing;

    this.state.storage.sql.exec(
      `UPDATE nodes SET ema_ms=?, samples=?, err_count=?, err_window_end=?, was_failing=?,
         status='online', last_seen_at=?, total_requests=total_requests+1,
         total_success=total_success+?, total_failure=total_failure+?, total_wins=total_wins+?
       WHERE id=?`,
      emaMs,
      samples,
      errCount,
      errWindowEnd,
      isFailingNow ? 1 : 0,
      now,
      ok ? 1 : 0,
      ok ? 0 : 1,
      isWinner ? 1 : 0,
      nodeId,
    );

    if (transitioned) {
      this._alert(nodeId, isFailingNow ? "failing" : "recovered_errors").catch(
        () => {},
      );
    }
  }

  // ── Resource heartbeat (self-reports; legacy /report beacon adapts here too) ──
  _recordHeartbeat({
    nodeId,
    activeJobs = 0,
    queuedJobs = 0,
    cpuLoad = 0,
    memPct = 0,
    avgMs = null,
    requests = 0,
    errors = 0,
  }) {
    const row = this._ensureRow(nodeId);
    const now = Date.now();
    const wasDown = row.status === "offline";
    const healthy = this._liveErrCount(row) === 0;
    const nextLimit =
      row.concurrency_limit == null && !nodeMeta(nodeId)
        ? null
        : this._adjustConcurrency(row.concurrency_limit, healthy);

    let emaMs = row.ema_ms;
    let samples = row.samples;
    if (avgMs != null && requests > 0) {
      emaMs =
        samples === 0 ? avgMs : EMA_ALPHA * avgMs + (1 - EMA_ALPHA) * emaMs;
      samples += requests;
    }

    this.state.storage.sql.exec(
      `UPDATE nodes SET status='online', last_seen_at=?, down_since=0, self_reports=self_reports+1,
         active_jobs=?, queued_jobs=?, cpu_load=?, mem_pct=?, concurrency_limit=?,
         ema_ms=?, samples=?, total_requests=total_requests+?, total_failure=total_failure+?
       WHERE id=?`,
      now,
      activeJobs,
      queuedJobs,
      cpuLoad,
      memPct,
      nextLimit,
      emaMs,
      samples,
      requests,
      errors,
      nodeId,
    );

    if (wasDown) this._alert(nodeId, "recovered_down").catch(() => {});
  }

  _scoresSnapshot() {
    const rows = this.state.storage.sql.exec(`SELECT * FROM nodes`).toArray();
    const out = {};
    for (const r of rows) {
      out[r.id] = {
        emaMs: r.ema_ms,
        errCount: this._liveErrCount(r),
        score: this._score(r),
        stressed: this._liveErrCount(r) >= STRESSED_THRESHOLD,
        failing: this._liveErrCount(r) >= FAILING_THRESHOLD,
        status: r.status,
        concurrencyLimit: r.concurrency_limit,
        activeJobs: r.active_jobs,
        samples: r.samples,
      };
    }
    return out;
  }

  // ── Alerts (max 3 / 5 min, 10s min gap) ──────────────────────────────
  _canAlert() {
    const now = Date.now();
    let count = parseInt(this._getMeta("alertCount", "0"), 10);
    let windowEnd = parseInt(this._getMeta("alertWindowEnd", "0"), 10);
    const lastAlert = parseInt(this._getMeta("lastAlert", "0"), 10);
    if (now > windowEnd) {
      count = 0;
      windowEnd = now + 5 * 60_000;
    }
    if (count >= 3) return false;
    if (now - lastAlert < 10_000) return false;
    this._setMeta("alertCount", count + 1);
    this._setMeta("alertWindowEnd", windowEnd);
    this._setMeta("lastAlert", now);
    return true;
  }

  async _alert(nodeId, kind) {
    const url = this.env?.ALERTS_WEBHOOK_URL || this.env?.DISCORD_WEBHOOK_URL;
    if (!url || !this._canAlert()) return;
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
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "Posterium Alerts",
          embeds: [
            {
              title: copy.title,
              description: copy.desc,
              color: copy.color,
              timestamp: new Date().toISOString(),
            },
          ],
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (_) {}
  }

  // ── fetch() router ───────────────────────────────────────────────────
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/report-batch") {
        const { outcomes } = await request.json();
        for (const o of outcomes || []) this._recordOutcome(o);
        return Response.json({ ok: true, count: outcomes?.length ?? 0 });
      }
      if (request.method === "POST" && url.pathname === "/node-report") {
        const body = await request.json();
        this._recordHeartbeat(body);
        return Response.json({ ok: true });
      }
      // Legacy beacon from core/serverlessReporter.js (Vercel/Netlify):
      // { type: 'online' | 'metrics', node, ts, snapshot? }
      if (request.method === "POST" && url.pathname === "/report") {
        const body = await request.json().catch(() => null);
        if (!body?.node)
          return Response.json(
            { ok: false, error: "missing node" },
            { status: 400 },
          );
        if (body.type === "metrics" && body.snapshot) {
          this._recordHeartbeat({
            nodeId: body.node,
            avgMs: body.snapshot.jobDuration?.avg ?? null,
            requests: body.snapshot.requests ?? 0,
            errors: body.snapshot.errors ?? 0,
          });
        } else {
          // 'online' (cold start ping) — just mark it alive
          this._recordHeartbeat({ nodeId: body.node, requests: 0, errors: 0 });
        }
        return Response.json({ ok: true });
      }
      if (url.pathname === "/scores") {
        return Response.json(this._scoresSnapshot());
      }
      if (url.pathname === "/ensure-alarm") {
        const alarm = await this.state.storage.getAlarm();
        if (!alarm)
          await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/snapshot") {
        return Response.json({
          nodes: this.state.storage.sql.exec(`SELECT * FROM nodes`).toArray(),
          lastDashboardUpdate: this._getMeta("lastDashboardUpdate"),
        });
      }
    } catch (e) {
      return Response.json({ error: e?.message || String(e) }, { status: 500 });
    }
    return new Response("not found", { status: 404 });
  }

  // ── Alarm: health polling (every tick) + dashboard (hourly) ──────────
  async alarm() {
    const now = Date.now();
    await this._pollHealthChecks(now);
    this._adjustAllConcurrency();

    const lastDash = parseInt(this._getMeta("lastDashboardUpdate", "0"), 10);
    if (now - lastDash >= DASHBOARD_INTERVAL_MS) {
      await this._updateDashboard(now);
      this._setMeta("lastDashboardUpdate", now);
    }

    await this.state.storage.setAlarm(now + ALARM_INTERVAL_MS);
  }

  async _pollHealthChecks(now) {
    const targets = ALL_NODES.filter((n) => n.features.supportsHealthCheck);
    const stale = targets.filter((n) => {
      const row = this._ensureRow(n.id);
      return now - (row.last_seen_at || 0) > STALE_REPORT_MS;
    });
    if (stale.length === 0) return;

    // Capped at MAX_CONCURRENT_HEALTH_FETCHES (5) — DOs are limited to 6
    // simultaneous outgoing connections per request; a cold cache with all
    // 7 health-check nodes stale at once would otherwise exceed that.
    await mapWithConcurrency(
      stale,
      MAX_CONCURRENT_HEALTH_FETCHES,
      async (n) => {
        const row = this._row(n.id);
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), HEALTH_FETCH_TIMEOUT_MS);
        try {
          const res = await fetch(`${n.url}/health`, {
            signal: ac.signal,
            headers: { "User-Agent": "FleetHealth-DO/1.0" },
          });
          clearTimeout(t);
          if (!res.ok) throw new Error(`http_${res.status}`);
          const h = await res.json().catch(() => ({}));
          const wasDown = row.status === "offline";
          this.state.storage.sql.exec(
            `UPDATE nodes SET status='online', last_seen_at=?, down_since=0,
             active_jobs=COALESCE(?, active_jobs), queued_jobs=COALESCE(?, queued_jobs)
           WHERE id=?`,
            now,
            h.activeJobs ?? null,
            h.queuedJobs ?? null,
            n.id,
          );
          if (wasDown) await this._alert(n.id, "recovered_down");
        } catch (_) {
          clearTimeout(t);
          const wasOnline = row.status !== "offline";
          this.state.storage.sql.exec(
            `UPDATE nodes SET status='offline', down_since=CASE WHEN down_since=0 THEN ? ELSE down_since END WHERE id=?`,
            now,
            n.id,
          );
          if (wasOnline) await this._alert(n.id, "down");
        }
      },
    );
  }

  _adjustAllConcurrency() {
    const rows = this.state.storage.sql.exec(`SELECT * FROM nodes`).toArray();
    for (const r of rows) {
      if (r.concurrency_limit == null) continue;
      const healthy = this._liveErrCount(r) === 0;
      const next = this._adjustConcurrency(r.concurrency_limit, healthy);
      if (next !== r.concurrency_limit) {
        this.state.storage.sql.exec(
          `UPDATE nodes SET concurrency_limit=? WHERE id=?`,
          next,
          r.id,
        );
      }
    }
  }

  async _updateDashboard(now) {
    const url = this.env?.DISCORD_WEBHOOK_URL;
    if (!url) return;
    const rows = this.state.storage.sql.exec(`SELECT * FROM nodes`).toArray();

    const fields = ALL_NODES.filter((n) => n.features.inTest !== false).map(
      (n) => {
        const r = rows.find((x) => x.id === n.id);
        if (!r)
          return {
            name: "\u200B",
            value: `**${n.label}**\nNo data yet`,
            inline: true,
          };

        const err = this._liveErrCount(r);
        const emoji = !n.features.supportsHealthCheck
          ? "⚪"
          : r.status === "offline"
            ? "🔴"
            : err >= FAILING_THRESHOLD
              ? "🟠"
              : err >= STRESSED_THRESHOLD
                ? "🟡"
                : "🟢";

        const uptimeMs =
          r.status === "online" && r.first_seen_at ? now - r.first_seen_at : 0;
        const uptimeStr =
          uptimeMs > 0
            ? `${Math.floor(uptimeMs / 3600000)}h${Math.floor((uptimeMs % 3600000) / 60000)}m`
            : "—";
        const limitStr =
          r.concurrency_limit != null ? `/${r.concurrency_limit}` : "/∞";
        const successRate =
          r.total_requests > 0
            ? Math.round((100 * r.total_success) / r.total_requests)
            : null;

        const lines = [
          `${emoji} **${n.label}**`,
          r.status === "offline"
            ? `❌ Offline${r.down_since ? ` (${Math.floor((now - r.down_since) / 60000)}m)` : ""}`
            : `Active: ${r.active_jobs}  Queue: ${r.queued_jobs}  Up: ${uptimeStr}`,
          `Requests: ${r.total_requests}  Wins: ${r.total_wins}  Success: ${successRate != null ? successRate + "%" : "—"}`,
          r.samples > 0
            ? `EMA: ${Math.round(r.ema_ms)}ms  n=${r.samples}  Limit${limitStr}`
            : `No samples yet  Limit${limitStr}`,
        ];
        return { name: "\u200B", value: lines.join("\n"), inline: true };
      },
    );

    const anyDown = rows.some((r) => r.status === "offline");
    const anyFailing = rows.some(
      (r) => this._liveErrCount(r) >= FAILING_THRESHOLD,
    );
    const anyStressed = rows.some(
      (r) => this._liveErrCount(r) >= STRESSED_THRESHOLD,
    );

    const payload = {
      username: "Posterium LB — v15",
      embeds: [
        {
          title: "🖼️ Raster Node Fleet",
          color:
            anyDown || anyFailing
              ? 0xf87171
              : anyStressed
                ? 0xfacc15
                : 0x4ade80,
          fields,
          footer: { text: `Hourly poll · ${new Date(now).toISOString()}` },
        },
      ],
    };

    const messageId = this._getMeta("dashboardMessageId");
    if (messageId) {
      const edit = await fetch(`${url}/messages/${messageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8_000),
      }).catch(() => null);
      if (edit?.ok) return;
      if (edit?.status === 404) this._setMeta("dashboardMessageId", "");
    }

    const post = await fetch(`${url}?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    }).catch(() => null);
    if (post?.ok) {
      const data = await post.json();
      if (data.id) this._setMeta("dashboardMessageId", data.id);
    }
  }
}
