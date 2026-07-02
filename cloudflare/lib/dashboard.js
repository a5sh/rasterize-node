// cloudflare/lib/dashboard.js
//
// Hourly Discord fleet-health dashboard (edit-in-place via KV-stored
// message ID), plus a CORS proxy helper for fetching a node's /health JSON
// through Worker B (avoids mixed-content issues for a browser dashboard
// hitting http:// VPS nodes). The proxy helper is preserved from the
// original file exactly as it existed there — it is not currently wired to
// a route in worker.js's fetch handler (no pathname check dispatches to
// it), so it remains unreachable in production until a route is added.
// Not fabricating that route here since that would be a behavior change,
// not a structural one.

let lastDashboardUpdate = 0;

export function getLastDashboardUpdate() {
  return lastDashboardUpdate;
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
 * @param {Array} t1Nodes
 * @param {Array} t2Nodes
 * @param {object} health - createHealthState() instance
 * @param {function} log
 */
export async function updateDashboard(env, t1Nodes, t2Nodes, health, log) {
  if (!env.DISCORD_WEBHOOK_URL) return;
  lastDashboardUpdate = Date.now();

  const allNodes = [...t1Nodes, ...t2Nodes];

  // Only health-check nodes that expose /health; skip CDN/wsrv nodes
  const healths = await Promise.all(
    allNodes.map(async (n) => {
      if (!n.supportsHealthCheck) return { ...n, h: null };
      const h = await fetchNodeHealth(n.baseUrl);
      return { ...n, h };
    }),
  );

  // 🟢 online  🟡 stressed  🟠 failing  🔴 VPS down  💤 serverless cold  ⚪ CDN/no-healthcheck
  const emoji = (n, h) => {
    if (!n.supportsHealthCheck) return "⚪";
    if (!h) return n.type === "vercel" || n.type === "netlify" ? "💤" : "🔴";
    if (health.isFailing(n.id)) return "🟠";
    if (health.isStressed(n.id)) return "🟡";
    return "🟢";
  };

  const fields = healths.map(({ id, type, h, supportsHealthCheck }) => {
    const perf = health.perfMap.get(id);
    const limit =
      t1Nodes.find((n) => n.id === id)?.concurrencyLimit ??
      t2Nodes.find((n) => n.id === id)?.concurrencyLimit ??
      null;
    const limitStr = limit != null ? `/${limit}` : "/∞";

    const healthLine = !supportsHealthCheck
      ? "CDN / No health endpoint"
      : !h
        ? type === "vercel" || type === "netlify"
          ? "Serverless — may be cold"
          : "❌ Offline"
        : `Active: ${h.activeJobs ?? "?"}  Queue: ${h.queuedJobs ?? "?"}  Up: ${h.uptime != null ? `${Math.floor(h.uptime / 3600)}h${Math.floor((h.uptime % 3600) / 60)}m` : "?"}`;

    const lines = [
      `${emoji({ id, type, supportsHealthCheck }, h)} **${id}**`,
      healthLine,
      `Errors: ${health.errCount(id)}  In-flight: ${health.inFlight(id)}${limitStr}`,
      perf
        ? `EMA: ${Math.round(perf.emaMs)}ms  Score: ${Math.round(health.nodeScore(id))}  n=${perf.sampleCount}`
        : "No samples yet",
    ]
      .filter(Boolean)
      .join("\n");

    return { name: "\u200B", value: lines, inline: true };
  });

  const anyFailing = allNodes.some((n) => health.isFailing(n.id));
  const anyStressed = allNodes.some((n) => health.isStressed(n.id));

  const payload = {
    username: "Posterium LB — v13",
    embeds: [
      {
        title: "🖼️ Raster Node Fleet",
        color: anyFailing ? 0xf87171 : anyStressed ? 0xfacc15 : 0x4ade80,
        fields,
        footer: { text: `Hourly poll · ${new Date().toISOString()}` },
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
