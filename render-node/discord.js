// render-node/discord.js
//
// Two responsibilities:
//   1. Send error/warning embeds as new messages to the webhook.
//   2. Maintain a single "live dashboard" message that is edited in-place
//      to reflect current node status (online, load, error count, uptime).
//
// The dashboard message ID is persisted to disk so it survives process
// restarts without creating a new pinned message every time.

import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';

const WEBHOOK_URL    = process.env.DISCORD_WEBHOOK_URL || 'https://discord.com/api/webhooks/1484521396326502511/hOSVLWiK3MKCXzzwujgYtIa6zOiTkHnjO4GmGYvTeGTLmBjEO0kTvs5x4ySWFC4htpg5';
const MSG_ID_FILE    = path.join(process.cwd(), '.dashboard_msg_id');
const DASHBOARD_INTERVAL_MS = 30_000; // edit dashboard every 30s
const NODE_NAME      = process.env.RENDER_SERVICE_NAME || os.hostname();

// ── Shared stats object — mutated by server.js ────────────────────────────────
export const stats = {
  startedAt:    Date.now(),
  requests:     0,
  errors:       0,
  resvgFails:   0,
  wsrvFallbacks: 0,
  activeJobs:   0,
  queuedJobs:   0,
  lastError:    null,   // { message, ts }
  status:       'starting', // 'online' | 'degraded' | 'starting'
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function uptimeStr() {
  const s   = Math.floor((Date.now() - stats.startedAt) / 1000);
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

function statusColor() {
  if (stats.status === 'online')    return 0x2ecc71; // green
  if (stats.status === 'degraded')  return 0xe67e22; // orange
  return 0x95a5a6;                                    // grey (starting)
}

function statusEmoji() {
  if (stats.status === 'online')   return '🟢';
  if (stats.status === 'degraded') return '🟠';
  return '⚪';
}

function buildDashboardPayload() {
  const now = new Date().toISOString();
  return {
    embeds: [{
      title:       `${statusEmoji()} Rasterizer Node — ${NODE_NAME}`,
      color:       statusColor(),
      fields: [
        { name: '📊 Status',          value: stats.status,                          inline: true  },
        { name: '⏱ Uptime',           value: uptimeStr(),                           inline: true  },
        { name: '📥 Total Requests',  value: String(stats.requests),               inline: true  },
        { name: '⚡ Active Jobs',      value: String(stats.activeJobs),             inline: true  },
        { name: '🕐 Queued Jobs',      value: String(stats.queuedJobs),             inline: true  },
        { name: '❌ Total Errors',     value: String(stats.errors),                 inline: true  },
        { name: '🔁 resvg Fails',      value: String(stats.resvgFails),             inline: true  },
        { name: '🌐 wsrv Fallbacks',   value: String(stats.wsrvFallbacks),          inline: true  },
        {
          name:   '🕵 Last Error',
          value:  stats.lastError
            ? `\`${stats.lastError.message.slice(0, 200)}\`\n<t:${Math.floor(stats.lastError.ts / 1000)}:R>`
            : 'None',
          inline: false,
        },
      ],
      footer: { text: `Last updated` },
      timestamp: now,
    }],
  };
}

// ── Webhook fetch wrappers ─────────────────────────────────────────────────────

async function webhookPost(payload) {
  if (!WEBHOOK_URL) return null;
  const res = await fetch(`${WEBHOOK_URL}?wait=true`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error(`[discord] POST failed: ${res.status}`);
    return null;
  }
  return res.json();
}

async function webhookPatch(messageId, payload) {
  if (!WEBHOOK_URL || !messageId) return false;
  const res = await fetch(`${WEBHOOK_URL}/messages/${messageId}`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  return res.ok;
}

// ── Dashboard message lifecycle ───────────────────────────────────────────────

let _dashboardMsgId = null;

async function loadOrCreateDashboard() {
  // Try to load a persisted message ID from disk
  try {
    const stored = fs.readFileSync(MSG_ID_FILE, 'utf8').trim();
    if (stored) {
      // Verify the message still exists by attempting a PATCH
      const ok = await webhookPatch(stored, buildDashboardPayload());
      if (ok) {
        _dashboardMsgId = stored;
        console.log(`[discord] Resumed dashboard message ${stored}`);
        return;
      }
      // Message was deleted — fall through to create a new one
    }
  } catch (_) {
    // File not found or unreadable — normal on first boot
  }

  // Create a fresh dashboard message
  const msg = await webhookPost(buildDashboardPayload());
  if (msg?.id) {
    _dashboardMsgId = msg.id;
    try { fs.writeFileSync(MSG_ID_FILE, msg.id, 'utf8'); } catch (_) {}
    console.log(`[discord] Created dashboard message ${msg.id}`);
  }
}

async function updateDashboard() {
  if (!_dashboardMsgId) return;
  const ok = await webhookPatch(_dashboardMsgId, buildDashboardPayload());
  if (!ok) {
    // Message was deleted externally — create a new one next tick
    _dashboardMsgId = null;
    try { fs.unlinkSync(MSG_ID_FILE); } catch (_) {}
    await loadOrCreateDashboard();
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Send a discrete error embed as a new message (does not touch the dashboard).
 * @param {string} title
 * @param {string} description
 * @param {object} [fields]  Array of { name, value } pairs
 */
export async function logError(title, description, fields = []) {
  if (!WEBHOOK_URL) return;
  stats.errors++;
  stats.lastError = { message: description, ts: Date.now() };
  if (stats.errors > 3) stats.status = 'degraded';

  await webhookPost({
    embeds: [{
      title:       `❌ ${title}`,
      description: `\`\`\`${description.slice(0, 1000)}\`\`\``,
      color:       0xe74c3c,
      fields:      [
        { name: 'Node',  value: NODE_NAME,           inline: true },
        { name: 'Time',  value: new Date().toISOString(), inline: true },
        ...fields,
      ],
      timestamp: new Date().toISOString(),
    }],
  }).catch(() => {});
}

/**
 * Call once when the server starts listening.
 */
export async function notifyOnline() {
  if (!WEBHOOK_URL) return;
  stats.status = 'online';
  stats.errors = 0; // reset degraded state on clean restart
  await loadOrCreateDashboard();

  // Periodic dashboard refresh
  setInterval(async () => {
    try { await updateDashboard(); } catch (_) {}
  }, DASHBOARD_INTERVAL_MS);
}

/**
 * Call when the server is about to exit (SIGTERM etc.).
 */
export async function notifyOffline(reason = 'SIGTERM') {
  if (!WEBHOOK_URL || !_dashboardMsgId) return;
  stats.status = 'offline';
  await webhookPatch(_dashboardMsgId, buildDashboardPayload()).catch(() => {});
}