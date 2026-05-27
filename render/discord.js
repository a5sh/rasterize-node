// render/discord.js
//
// REWRITTEN — Discord integration removed from this node.
// Metrics are collected locally (same logic as before) and forwarded to the
// Cloudflare Edge Hub at /report, which owns all Discord interactions and
// displays a unified fleet embed covering every node.
//
// Exported API is IDENTICAL to the old discord.js — server.js needs no changes.
//
// ENV VARS
//   CF_REPORT_URL        Override hub URL (default: https://r-cf.spicydevs.xyz/report)
//   RENDER_SERVICE_NAME  Node display name injected by Render.com

import os from 'node:os';

const CF_REPORT_URL      = process.env.CF_REPORT_URL || 'https://r-cf.spicydevs.xyz/report';
const NODE_NAME          = process.env.RENDER_SERVICE_NAME || os.hostname();
const REPORT_INTERVAL_MS = 5 * 60_000;   // flush + report every 5 minutes
const MAX_JITTER_MS      = 60_000;        // random start delay so nodes don't all report at once

// ── Metrics window ────────────────────────────────────────────────────────────
// Identical to the old discord.js — samples are collected between flushes.

const WINDOW_SIZE = 2000;

const _window = {
  jobDurationsMs: [],
  cpuSamples:     [],
  memSamples:     [],
  queueDepths:    [],
  wsrvFallbacks:  0,
  resvgFails:     0,
  requests:       0,
  errors:         0,
};

// ── Public stats object (mutated by server.js) ────────────────────────────────

export const stats = {
  startedAt:  Date.now(),
  activeJobs: 0,
  queuedJobs: 0,
  status:     'starting',
  lastError:  null,
};

// ── Counters ──────────────────────────────────────────────────────────────────

export function recordRequest()      { _window.requests++;                                               }
export function recordResvgFail()    { _window.resvgFails++;   stats.lastError = { message: 'resvg fail', ts: Date.now() }; }
export function recordWsrvFallback() { _window.wsrvFallbacks++;                                          }
export function recordError(msg)     { _window.errors++;       stats.lastError = { message: msg,          ts: Date.now() }; }

export function recordJobDuration(ms) {
  if (_window.jobDurationsMs.length < WINDOW_SIZE) _window.jobDurationsMs.push(ms);
}

// ── CPU / memory sampler ──────────────────────────────────────────────────────

let _prevCpuSample = _takeCpuSample();

function _takeCpuSample() {
  return os.cpus().map(c => ({ ...c.times }));
}

setInterval(() => {
  const next = _takeCpuSample();
  let totalIdle = 0, totalBusy = 0;
  next.forEach((cpu, i) => {
    const prev = _prevCpuSample[i];
    const idle = cpu.idle - prev.idle;
    const busy = (cpu.user - prev.user) + (cpu.sys  - prev.sys)
               + (cpu.nice - prev.nice) + (cpu.irq  - prev.irq);
    totalIdle += idle;
    totalBusy += busy;
  });
  const total  = totalIdle + totalBusy;
  const cpuPct = total > 0 ? Math.round((totalBusy / total) * 100) : 0;
  _prevCpuSample = next;

  const memPct = Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100);

  if (_window.cpuSamples.length  < WINDOW_SIZE) _window.cpuSamples.push(cpuPct);
  if (_window.memSamples.length  < WINDOW_SIZE) _window.memSamples.push(memPct);
  if (_window.queueDepths.length < WINDOW_SIZE) _window.queueDepths.push(stats.queuedJobs);
}, 5_000);

// ── Percentile helpers ────────────────────────────────────────────────────────

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function summarise(arr) {
  if (arr.length === 0) return { min: 0, max: 0, p50: 0, p95: 0, p99: 0, avg: 0, n: 0 };
  const s   = [...arr].sort((a, b) => a - b);
  const avg = Math.round(s.reduce((a, b) => a + b, 0) / s.length);
  return { min: s[0], max: s[s.length - 1], p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), avg, n: s.length };
}

function flushWindow() {
  const snap = {
    ts:            Date.now(),
    requests:      _window.requests,
    errors:        _window.errors,
    resvgFails:    _window.resvgFails,
    wsrvFallbacks: _window.wsrvFallbacks,
    jobDuration:   summarise(_window.jobDurationsMs),
    cpu:           summarise(_window.cpuSamples),
    mem:           summarise(_window.memSamples),
    queueDepth:    summarise(_window.queueDepths),
    cores:         os.cpus().length,
    totalMemMB:    Math.round(os.totalmem() / 1024 / 1024),
  };

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

// ── CF Hub reporting ──────────────────────────────────────────────────────────

async function reportToCF(type, extra = {}) {
  const payload = {
    type,
    node:  NODE_NAME,
    ts:    Date.now(),
    stats: {
      startedAt:  stats.startedAt,
      activeJobs: stats.activeJobs,
      queuedJobs: stats.queuedJobs,
      status:     stats.status,
      lastError:  stats.lastError,
    },
    ...extra,
  };

  try {
    await fetch(CF_REPORT_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(5_000),
    });
  } catch (e) {
    // Non-fatal — node keeps running even if the hub is temporarily unreachable.
    console.warn('[reporter] CF hub unreachable:', e.message);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Log an error to the CF hub (which surfaces it in the Discord embed).
 * Drop-in replacement for the old logError — third `fields` arg is ignored
 * (hub builds its own embed; raw data is more useful than pre-formatted fields).
 */
export async function logError(title, description, _fields = []) {
  recordError(description);
  await reportToCF('error', { title, description });
}

/**
 * Call once after the server starts listening.
 * Sends an 'online' report after a random jitter delay (to stagger fleet startup),
 * then schedules periodic metric flushes.
 */
export async function notifyOnline() {
  stats.status = 'online';

  const jitter = Math.floor(Math.random() * MAX_JITTER_MS);
  console.log(`[reporter] Starting — will report to CF hub after ${Math.round(jitter / 1000)}s`);
  await new Promise(r => setTimeout(r, jitter));

  await reportToCF('online');

  setInterval(async () => {
    const snapshot = flushWindow();
    stats.status   = snapshot.errors > 5 ? 'degraded' : 'online';
    await reportToCF('metrics', { snapshot });
  }, REPORT_INTERVAL_MS);
}

/**
 * Call in SIGTERM / SIGINT handler before process.exit().
 * Flushes current window and sends a final 'offline' report.
 */
export async function notifyOffline(reason = 'SIGTERM') {
  stats.status = 'offline';
  await reportToCF('offline', { reason, snapshot: flushWindow() });
}