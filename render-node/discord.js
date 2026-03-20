// render-node/discord.js

import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';

const WEBHOOK_URL   = process.env.DISCORD_WEBHOOK_URL || '';
const MSG_ID_FILE   = path.join(process.cwd(), '.dashboard_msg_id');
const NODE_NAME     = process.env.RENDER_SERVICE_NAME || os.hostname();

// How often to edit the dashboard embed. Each node picks a random offset
// on startup so all 4 nodes don't PATCH the webhook at the same millisecond.
const DASHBOARD_INTERVAL_MS = 5 * 60_000;  // 5 minutes base
const MAX_JITTER_MS         = 60_000;       // up to 1 minute of random offset

// Error messages: at most one Discord post per this window to avoid spam.
const ERROR_COOLDOWN_MS = 30_000;

// ── Internal metrics window ───────────────────────────────────────────────────
// Collects raw samples between dashboard flushes.
// On each flush the window is summarised (min/max/percentiles) then cleared.

const WINDOW_SIZE = 2000; // max samples kept in memory before flush

const _window = {
  jobDurationsMs: [],   // time each job spent in renderToBuffer() or wsrv fallback
  cpuSamples:     [],   // _cpuPercent snapshot taken every 5s
  memSamples:     [],   // memory used % taken every 5s
  queueDepths:    [],   // jobQueue.length sampled every 5s
  wsrvFallbacks:  0,
  resvgFails:     0,
  requests:       0,
  errors:         0,
};

// Snapshot of last flush — shown in the embed until the next flush
let _lastSnapshot = null;

// ── Public stats object (mutated by server.js) ────────────────────────────────
export const stats = {
  startedAt:    Date.now(),
  activeJobs:   0,
  queuedJobs:   0,
  status:       'starting',
  lastError:    null,
};

// Counters incremented by server.js
export function recordRequest()      { _window.requests++;                        }
export function recordResvgFail()    { _window.resvgFails++;   stats.lastError = { message: 'resvg fail', ts: Date.now() }; }
export function recordWsrvFallback() { _window.wsrvFallbacks++;                   }
export function recordError(msg)     { _window.errors++;       stats.lastError = { message: msg, ts: Date.now() }; }

/**
 * Record how long a single job took (ms).
 * Call this in server.js after each renderToBuffer() call.
 */
export function recordJobDuration(ms) {
  if (_window.jobDurationsMs.length < WINDOW_SIZE) {
    _window.jobDurationsMs.push(ms);
  }
}

// ── CPU / memory sampler ──────────────────────────────────────────────────────
const SAMPLE_INTERVAL_MS = 5_000;
let _cpuPercent  = 0;
let _prevCpuSample = _takeCpuSample();

function _takeCpuSample() {
  return os.cpus().map((c) => ({ ...c.times }));
}

function _refreshSystem() {
  // CPU delta
  const next = _takeCpuSample();
  let totalIdle = 0, totalBusy = 0;
  next.forEach((cpu, i) => {
    const prev = _prevCpuSample[i];
    const idle = cpu.idle - prev.idle;
    const busy = (cpu.user - prev.user) + (cpu.sys - prev.sys)
               + (cpu.nice - prev.nice) + (cpu.irq - prev.irq);
    totalIdle += idle;
    totalBusy += busy;
  });
  const total = totalIdle + totalBusy;
  _cpuPercent = total > 0 ? Math.round((totalBusy / total) * 100) : 0;
  _prevCpuSample = next;

  // Memory
  const memPct = Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100);

  // Push samples (cap size)
  if (_window.cpuSamples.length  < WINDOW_SIZE) _window.cpuSamples.push(_cpuPercent);
  if (_window.memSamples.length  < WINDOW_SIZE) _window.memSamples.push(memPct);
  if (_window.queueDepths.length < WINDOW_SIZE) _window.queueDepths.push(stats.queuedJobs);
}

setInterval(_refreshSystem, SAMPLE_INTERVAL_MS);

// ── Percentile helpers ────────────────────────────────────────────────────────

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function summarise(arr) {
  if (arr.length === 0) return { min: 0, max: 0, p50: 0, p95: 0, p99: 0, avg: 0, n: 0 };
  const s = [...arr].sort((a, b) => a - b);
  const avg = Math.round(s.reduce((a, b) => a + b, 0) / s.length);
  return {
    min: s[0],
    max: s[s.length - 1],
    p50: pct(s, 50),
    p95: pct(s, 95),
    p99: pct(s, 99),
    avg,
    n:   s.length,
  };
}

function flushWindow() {
  const snap = {
    ts:           Date.now(),
    requests:     _window.requests,
    errors:       _window.errors,
    resvgFails:   _window.resvgFails,
    wsrvFallbacks:_window.wsrvFallbacks,
    jobDuration:  summarise(_window.jobDurationsMs),
    cpu:          summarise(_window.cpuSamples),
    mem:          summarise(_window.memSamples),
    queueDepth:   summarise(_window.queueDepths),
    cores:        os.cpus().length,
    totalMemMB:   Math.round(os.totalmem() / 1024 / 1024),
  };

  // Reset window
  _window.jobDurationsMs = [];
  _window.cpuSamples     = [];
  _window.memSamples     = [];
  _window.queueDepths    = [];
  _window.requests       = 0;
  _window.errors         = 0;
  _window.resvgFails     = 0;
  _window.wsrvFallbacks  = 0;

  return snap;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function uptimeStr() {
  const s   = Math.floor((Date.now() - stats.startedAt) / 1000);
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

function statusColor() {
  if (stats.status === 'online')   return 0x2ecc71;
  if (stats.status === 'degraded') return 0xe67e22;
  if (stats.status === 'offline')  return 0xe74c3c;
  return 0x95a5a6;
}

function statusEmoji() {
  if (stats.status === 'online')   return '🟢';
  if (stats.status === 'degraded') return '🟠';
  if (stats.status === 'offline')  return '🔴';
  return '⚪';
}

function fmtDur(s) {
  // s is a summarise() object
  return `min \`${s.min}ms\` · p50 \`${s.p50}ms\` · p95 \`${s.p95}ms\` · p99 \`${s.p99}ms\` · max \`${s.max}ms\``;
}

function fmtPct(s) {
  return `avg \`${s.avg}%\` · p95 \`${s.p95}%\` · max \`${s.max}%\``;
}

function fmtQueue(s) {
  return `avg \`${s.avg}\` · p95 \`${s.p95}\` · max \`${s.max}\``;
}

function buildDashboardPayload(snap) {
  const hasSnap = snap !== null;

  const fields = [
    // ── Header row ────────────────────────────────────────────────────────
    { name: '📊 Status',   value: stats.status,                   inline: true },
    { name: '⏱ Uptime',    value: uptimeStr(),                    inline: true },
    { name: '⚡ Active',    value: String(stats.activeJobs),       inline: true },
  ];

  if (hasSnap) {
    const intervalMin = Math.round(DASHBOARD_INTERVAL_MS / 60_000);

    fields.push(
      // ── This interval's counters ──────────────────────────────────────
      { name: `📥 Requests (last ${intervalMin}m)`,  value: String(snap.requests),      inline: true },
      { name: `❌ Errors (last ${intervalMin}m)`,    value: String(snap.errors),        inline: true },
      { name: `🌐 wsrv Fallbacks`,                   value: String(snap.wsrvFallbacks), inline: true },

      // ── Job duration percentiles ──────────────────────────────────────
      {
        name:   `⏱ Job Duration (n=${snap.jobDuration.n})`,
        value:  snap.jobDuration.n > 0
          ? fmtDur(snap.jobDuration)
          : '_No jobs this interval_',
        inline: false,
      },

      // ── CPU ───────────────────────────────────────────────────────────
      {
        name:   `🖥 CPU — ${snap.cores} core(s)`,
        value:  snap.cpu.n > 0 ? fmtPct(snap.cpu) : '_No samples_',
        inline: false,
      },

      // ── Memory ────────────────────────────────────────────────────────
      {
        name:   `💾 Memory — ${snap.totalMemMB} MB total`,
        value:  snap.mem.n > 0 ? fmtPct(snap.mem) : '_No samples_',
        inline: false,
      },

      // ── Queue depth ───────────────────────────────────────────────────
      {
        name:   '🕐 Queue Depth',
        value:  snap.queueDepth.n > 0 ? fmtQueue(snap.queueDepth) : '_No samples_',
        inline: false,
      },

      // ── Tuning hint ───────────────────────────────────────────────────
      {
        name:   '💡 MAX_CONCURRENT hint',
        value:  snap.cpu.n > 0
          ? concurrencyHint(snap)
          : '_Not enough data yet_',
        inline: false,
      },
    );
  } else {
    fields.push({
      name:  '📊 Metrics',
      value: `_First snapshot in ${Math.round(DASHBOARD_INTERVAL_MS / 60_000)} min_`,
      inline: false,
    });
  }

  // Last error always shown
  fields.push({
    name:   '🕵 Last Error',
    value:  stats.lastError
      ? `\`${stats.lastError.message.slice(0, 200)}\`\n<t:${Math.floor(stats.lastError.ts / 1000)}:R>`
      : 'None',
    inline: false,
  });

  return {
    embeds: [{
      title:     `${statusEmoji()} Rasterizer — ${NODE_NAME}`,
      color:     statusColor(),
      fields,
      footer:    { text: `Updated every ${Math.round(DASHBOARD_INTERVAL_MS / 60_000)}m · intervals reset on flush` },
      timestamp: new Date().toISOString(),
    }],
  };
}

function concurrencyHint(snap) {
  const p95cpu   = snap.cpu.p95;
  const p95queue = snap.queueDepth.p95;
  const cores    = snap.cores;
  const current  = parseInt(process.env.MAX_CONCURRENT || '4', 10);

  if (p95cpu < 40 && p95queue === 0) {
    return `✅ Underutilised (p95 CPU ${p95cpu}%, no queuing). Consider raising MAX_CONCURRENT to **${Math.min(current + 2, cores * 4)}**.`;
  }
  if (p95cpu > 80 || p95queue > 2) {
    return `⚠️ Saturated (p95 CPU ${p95cpu}%, p95 queue ${p95queue}). Consider lowering MAX_CONCURRENT to **${Math.max(current - 1, 1)}**.`;
  }
  return `✅ Well-balanced (p95 CPU ${p95cpu}%, p95 queue ${p95queue}). Current MAX_CONCURRENT=${current} looks good.`;
}

// ── Webhook helpers ───────────────────────────────────────────────────────────

async function webhookPost(payload) {
  if (!WEBHOOK_URL) return null;
  try {
    const res = await fetch(`${WEBHOOK_URL}?wait=true`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (!res.ok) { console.error(`[discord] POST failed: ${res.status}`); return null; }
    return res.json();
  } catch (e) {
    console.error('[discord] POST error:', e.message);
    return null;
  }
}

async function webhookPatch(messageId, payload) {
  if (!WEBHOOK_URL || !messageId) return false;
  try {
    const res = await fetch(`${WEBHOOK_URL}/messages/${messageId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Dashboard message lifecycle ───────────────────────────────────────────────

let _dashboardMsgId = null;

async function loadOrCreateDashboard() {
  try {
    const stored = fs.readFileSync(MSG_ID_FILE, 'utf8').trim();
    if (stored) {
      const ok = await webhookPatch(stored, buildDashboardPayload(_lastSnapshot));
      if (ok) {
        _dashboardMsgId = stored;
        console.log(`[discord] Resumed dashboard ${stored}`);
        return;
      }
    }
  } catch (_) {}

  const msg = await webhookPost(buildDashboardPayload(_lastSnapshot));
  if (msg?.id) {
    _dashboardMsgId = msg.id;
    try { fs.writeFileSync(MSG_ID_FILE, msg.id, 'utf8'); } catch (_) {}
    console.log(`[discord] Created dashboard ${msg.id}`);
  }
}

async function runDashboardCycle() {
  // 1. Flush the current window into a snapshot
  _lastSnapshot = flushWindow();

  // 2. Update degraded status based on this interval's error rate
  if (stats.status !== 'offline') {
    stats.status = _lastSnapshot.errors > 5 ? 'degraded' : 'online';
  }

  // 3. Edit the dashboard message in-place
  if (!_dashboardMsgId) {
    await loadOrCreateDashboard();
    return;
  }
  const ok = await webhookPatch(_dashboardMsgId, buildDashboardPayload(_lastSnapshot));
  if (!ok) {
    _dashboardMsgId = null;
    try { fs.unlinkSync(MSG_ID_FILE); } catch (_) {}
    await loadOrCreateDashboard();
  }
}

// ── Error rate limiting ───────────────────────────────────────────────────────

let _lastErrorPost = 0;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Post a standalone error embed.
 * Rate-limited to one post per ERROR_COOLDOWN_MS to prevent webhook spam
 * during cascading failures. Suppressed errors are still counted internally.
 */
export async function logError(title, description, fields = []) {
  recordError(description);
  if (!WEBHOOK_URL) return;

  const now = Date.now();
  if (now - _lastErrorPost < ERROR_COOLDOWN_MS) {
    // Suppressed — still counted in _window.errors, will appear in next snapshot
    return;
  }
  _lastErrorPost = now;

  await webhookPost({
    embeds: [{
      title:       `❌ ${title}`,
      description: `\`\`\`${description.slice(0, 1000)}\`\`\``,
      color:       0xe74c3c,
      fields: [
        { name: 'Node', value: NODE_NAME,                inline: true },
        { name: 'Time', value: new Date().toISOString(), inline: true },
        ...fields,
      ],
      timestamp: new Date().toISOString(),
    }],
  }).catch(() => {});
}

export async function notifyOnline() {
  if (!WEBHOOK_URL) return;
  stats.status = 'online';

  // Stagger: random delay up to MAX_JITTER_MS so all nodes don't
  // hit the webhook at the same time on a coordinated deployment.
  const jitter = Math.floor(Math.random() * MAX_JITTER_MS);
  console.log(`[discord] Starting with ${Math.round(jitter / 1000)}s jitter`);

  await new Promise((r) => setTimeout(r, jitter));
  await loadOrCreateDashboard();

  // Schedule periodic flush + dashboard edit, offset by the same jitter
  // so subsequent cycles also stay staggered between nodes.
  setInterval(async () => {
    try { await runDashboardCycle(); } catch (e) {
      console.error('[discord] Dashboard cycle error:', e.message);
    }
  }, DASHBOARD_INTERVAL_MS);
}

export async function notifyOffline(reason = 'SIGTERM') {
  if (!WEBHOOK_URL || !_dashboardMsgId) return;
  stats.status = 'offline';
  _lastSnapshot = flushWindow(); // final flush
  await webhookPatch(_dashboardMsgId, buildDashboardPayload(_lastSnapshot)).catch(() => {});
}