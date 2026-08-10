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
// or queries Analytics Engine.

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

  const fields = allNodes.map((n) => {
    const r = snapshot?.[n.id] || null;
    if (!r) {
      return { name: "\u200B", value: `**${n.label}**\nNo data yet`, inline: true };
    }

    const limitStr =
      r.concurrencyLimit != null ? `/${r.concurrencyLimit}` : "/∞";
    const uptimeMs =
      r.status === "online" && r.first_seen_at
        ? Date.now() - r.first_seen_at
        : 0;
    const uptimeStr =
      uptimeMs > 0
        ? `${Math.floor(uptimeMs / 3600000)}h${Math.floor((uptimeMs % 3600000) / 60000)}m`
        : "—";
    const successRate =
      r.total_requests > 0
        ? Math.round((100 * r.total_success) / r.total_requests)
        : null;

    const lines = [
      `${emoji(n, r)} **${n.label}**`,
      r.status === "offline"
        ? `❌ Offline${r.down_since ? ` (${Math.floor((Date.now() - r.down_since) / 60000)}m)` : ""}`
        : n.supportsHealthCheck
          ? `Active: ${r.activeJobs ?? "?"}  Queue: ${r.queuedJobs ?? "?"}  Up: ${uptimeStr}`
          : "CDN / No health endpoint",
      `Requests: ${r.total_requests ?? 0}  Wins: ${r.total_wins ?? 0}  Success: ${successRate != null ? successRate + "%" : "—"}`,
      r.samples > 0
        ? `EMA: ${Math.round(r.emaMs ?? 9999)}ms  n=${r.samples}  Limit${limitStr}`
        : `No samples yet  Limit${limitStr}`,
    ].filter(Boolean);

    return { name: "\u200B", value: lines.join("\n"), inline: true };
  });

  const rows = Object.entries(snapshot || {}).filter(([id]) => allIds.has(id));
  const anyDown = rows.some(([, r]) => r.status === "offline");
  const anyFailing = rows.some(([, r]) => r.failing);
  const anyStressed = rows.some(([, r]) => r.stressed);

  const payload = {
    username: "Posterium LB — v14",
    embeds: [
      {
        title: "🖼️ Raster Node Fleet",
        color: anyDown || anyFailing ? 0xf87171 : anyStressed ? 0xfacc15 : 0x4ade80,
        fields,
        footer: { text: `15-min poll · ${new Date().toISOString()}` },
      },
    ],
  };

  let messageId = null;
  try {
    messageId = await env.DASHBOARD_KV?.get("discord:messageId");
  } catch (_) {}

  if (messageId) {
    try {
      const editRes = await fetch(
        `${env.DISCORD_WEBHOOK_URL}/messages/${messageId}`,
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
    const postRes = await fetch(`${env.DISCORD_WEBHOOK_URL}?wait=true`, {
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
