// cloudflare/lib/dashboard.js
//
// Discord fleet-health dashboard (edit-in-place via KV-stored message ID),
// plus a CORS proxy helper for fetching a node's /health JSON through
// Worker B (avoids mixed-content issues for a browser dashboard hitting
// http:// VPS nodes). The proxy helper is preserved from the original file
// exactly as it existed there — it is not currently wired to a route in
// worker.js's fetch handler (no pathname check dispatches to it), so it
// remains unreachable in production until a route is added. Not fabricating
// that route here since that would be a behavior change, not a structural
// one.
//
// The dashboard is PURELY snapshot-driven: lib/fleetSync.js's 15-minute
// cron computes the fleet snapshot into DASHBOARD_KV ("fleet:snapshot") and
// calls updateDashboard() with it. Nothing here talks to Durable Objects
// or queries Analytics Engine. Per-node /health details refresh every
// 15 minutes; the short analytics window (row.window) refreshes hourly.
//
// Embed presentation is shared with fleetSync.js alerts via embedBrand.js
// (frontend public/ assets served from posterium.xyz + link-button Action
// Row — webhooks only support non-interactive components).

import { BRAND, actionRowLinkButtons } from "./embedBrand.js";
import NODE_CONFIG from "../../assets/nodes.config.js";

// Node views passed in from fleetSync (T1_NODES/T2_NODES) are the FLAT
// registry shape — no label/region/specs. Resolve display metadata from the
// full NODE_CONFIG so labels aren't lost (they were "undefined" before).
const nodeMeta = (id) => NODE_CONFIG.nodes.find((n) => n.id === id) || null;

export async function getLastDashboardUpdate(env) {
  try {
    const v = await env?.DASHBOARD_KV?.get("dashboards:last_update");
    return v ? Number(v) : 0;
  } catch {
    return 0;
  }
}

export async function fetchNodeHealth(baseUrl) {
  try {
    const r = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(4_000),
      headers: { "User-Agent": "SpicyDevs-LB/12.0" },
    });
    return r.ok ? await r.json().catch(() => null) : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} env
 * @param {object} snapshot - fleet snapshot rows from DASHBOARD_KV
 *        ("fleet:snapshot"), keyed by node id. See lib/fleetSync.js.
 * @param {function} log
 * @param {{t1Nodes: Array, t2Nodes: Array}} pool
 */
export async function updateDashboard(env, snapshot, log, { t1Nodes, t2Nodes } = {}) {
  if (!env.DISCORD_WEBHOOK_URL) return;

  const allNodes = [...(t1Nodes || []), ...(t2Nodes || [])];
  const allIds = new Set(allNodes.map((n) => n.id));

  const emoji = (n, r) => {
    if (!n.supportsHealthCheck) return "⚪";
    if (!r || r.status === "unknown") return "💤";
    if (r.status === "offline") return "🔴";
    if (r.failing) return "🟠";
    if (r.stressed) return "🟡";
    return "🟢";
  };

  const fmt = (n) =>
    n == null
      ? "—"
      : n >= 1_000_000
        ? `${(n / 1_000_000).toFixed(1)}M`
        : n >= 1_000
          ? `${(n / 1_000).toFixed(1)}k`
          : String(n);
  const dur = (ms) =>
    ms !== null && ms > 0
      ? `${Math.floor(ms / 3600000)}h${Math.floor((ms % 3600000) / 60000)}m`
      : "—";

  const fields = [];
  const sectionHeader = (text) =>
    fields.push({ name: text, value: "\u200B", inline: false });
  const nodeField = (n) => {
    const meta = nodeMeta(n.id);
    const r = snapshot?.[n.id] || null;
    if (!r) {
      fields.push({
        name: `⚪ ${meta?.label || n.id}`,
        value: "No data yet",
        inline: true,
      });
      return;
    }

    const limitStr =
      r.concurrencyLimit != null ? `/${r.concurrencyLimit}` : "/∞";
    const uptimeStr =
      r.status === "online" && r.first_seen_at
        ? dur(Date.now() - r.first_seen_at)
        : "—";
    const successRate =
      r.total_requests > 0
        ? Math.round((100 * r.total_success) / r.total_requests)
        : null;

    // ── /health details captured by the last poll (15-min cadence) ──
    const h = r.health || null;
    const healthLine = h
      ? h.iconCount != null
        ? `v${h.version ?? "?"} · icons ${fmt(h.iconCount)} (${h.iconAgeMs != null ? Math.max(1, Math.round(h.iconAgeMs / 60000)) : "?"}m)${h.fontReady != null ? ` · font ${h.fontReady ? "✓" : "✗"}` : ""}`
        : `v${h.version ?? "?"} · ${h.workerCount ?? "?"} workers · respawn ${h.pendingRespawns ?? 0} · proc ${h.uptime != null ? dur(h.uptime * 1000) : "—"}`
      : null;

    // ── Short analytics window (hourly refresh) ──
    const w = r.window || null;
    const windowLine = w
      ? w.samples > 0
        ? `15m · ${fmt(w.samples)} req · ${w.errors} err · ${Math.round(w.avgMs)}ms avg`
        : "15m · no traffic"
      : null;

    const lines = [
      r.status === "offline"
        ? `❌ Offline${r.down_since ? ` (${Math.floor((Date.now() - r.down_since) / 60000)}m)` : ""}`
        : n.supportsHealthCheck
          ? `Active: ${r.activeJobs ?? "?"}  Queue: ${r.queuedJobs ?? "?"}  Up: ${uptimeStr}`
          : "CDN / No health endpoint",
      healthLine,
      windowLine,
      `Requests: ${fmt(r.total_requests ?? 0)}  Wins: ${fmt(r.total_wins ?? 0)}  Success: ${successRate != null ? successRate + "%" : "—"}`,
      r.samples > 0
        ? `EMA: ${Math.round(r.emaMs ?? 9999)}ms  n=${r.samples}  Limit${limitStr}`
        : `No samples yet  Limit${limitStr}`,
    ].filter(Boolean);

    fields.push({
      name: `${emoji(n, r)} ${meta?.label || n.id}`,
      value: lines.join("\n"),
      inline: true,
    });
  };

  // T1 primary pool first, then T2 fallback — each under its own header field.
  if (t1Nodes?.length) {
    sectionHeader("🥇 Tier 1 — Primary pool");
    for (const n of t1Nodes) nodeField(n);
  }
  if (t2Nodes?.length) {
    sectionHeader("🥈 Tier 2 — Fallback pool");
    for (const n of t2Nodes) nodeField(n);
  }

  const rows = Object.entries(snapshot || {}).filter(([id]) => allIds.has(id));
  const anyDown = rows.some(([, r]) => r.status === "offline");
  const anyFailing = rows.some(([, r]) => r.failing);
  const anyStressed = rows.some(([, r]) => r.stressed);

  // One-line fleet summary under the title.
  const counts = { online: 0, offline: 0, failing: 0, stressed: 0 };
  for (const [, r] of rows) {
    if (r.status === "offline") counts.offline++;
    else counts.online++;
    if (r.failing) counts.failing++;
    else if (r.stressed) counts.stressed++;
  }
  const totalReq = rows.reduce((s, [, r]) => s + (r.total_requests ?? 0), 0);
  const summaryBits = [
    `**${counts.online}/${rows.length} nodes online**`,
    `${fmt(totalReq)} requests served`,
  ];
  if (counts.failing) summaryBits.push(`🚨 ${counts.failing} failing`);
  else if (counts.stressed) summaryBits.push(`🟡 ${counts.stressed} stressed`);
  if (counts.offline) summaryBits.push(`🔴 ${counts.offline} down`);

  const payload = {
    username: "Posterium Fleet",
    avatar_url: BRAND.appIcon,
    embeds: [
      {
        title: "🖼️ Raster Node Fleet",
        description: summaryBits.join(" · "),
        color:
          anyDown || anyFailing ? 0xf87171 : anyStressed ? 0xfacc15 : 0x4ade80,
        thumbnail: { url: BRAND.appIcon },
        fields,
        footer: { text: "Health every 15m · analytics hourly" },
        timestamp: new Date().toISOString(),
      },
    ],
    // Link-button Action Row — non-interactive components, webhook-compatible.
    components: actionRowLinkButtons(),
  };

  let messageId = null;
  try {
    messageId = await env.DASHBOARD_KV?.get("discord:messageId");
  } catch (_) {}

  if (messageId) {
    try {
      const editRes = await fetch(
        `${env.DISCORD_WEBHOOK_URL}/messages/${messageId}?with_components=true`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (editRes.ok) return;
      if (editRes.status === 404) {
        await env.DASHBOARD_KV?.delete("discord:messageId").catch(() => {});
        messageId = null;
      } else {
        log("warn", "discord_edit_failed", { status: editRes.status });
      }
    } catch (e) {
      log("warn", "discord_edit_threw", { reason: e?.message });
    }
  }

  try {
    const postRes = await fetch(`${env.DISCORD_WEBHOOK_URL}?wait=true&with_components=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    });
    if (postRes.ok) {
      const data = await postRes.json();
      if (data.id)
        await env.DASHBOARD_KV?.put("discord:messageId", data.id).catch(
          () => {},
        );
    } else {
      log("warn", "discord_post_failed", { status: postRes.status });
    }
  } catch (e) {
    log("warn", "discord_post_threw", { reason: e?.message });
  }
}

function jsonError(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * CORS proxy for fetching an allow-listed node's /health JSON. Allowlist is
 * derived from NODE_CONFIG.nodes so an operator can't be tricked into
 * proxying to an arbitrary host.
 */
export async function handleProxy(request, nodeConfig) {
  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  if (!target) return jsonError(400, "Missing ?url=");
  const allowed = nodeConfig.nodes.map((n) => new URL(n.url).host);
  const tHost = (() => {
    try {
      return new URL(target).host;
    } catch {
      return "";
    }
  })();
  if (!allowed.includes(tHost)) return jsonError(403, "URL not in allowlist");
  try {
    const res = await fetch(target, {
      headers: { "User-Agent": "SpicyDevs-LB/12.0" },
      signal: AbortSignal.timeout(8_000),
    });
    const h = new Headers(res.headers);
    h.set("Access-Control-Allow-Origin", "*");
    return new Response(res.body, { status: res.status, headers: h });
  } catch (e) {
    return jsonError(502, e?.message);
  }
}
