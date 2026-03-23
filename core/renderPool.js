// core/renderPool.js
//
// Fixed-size pool of worker_threads for CPU-bound SVG → raster rendering.
//
// ── Package resolution ────────────────────────────────────────────────────────
// renderWorker.js lives in core/ but node_modules/ is in render-node/ (or node/).
// We pass serverDir (the calling server's __dirname) via workerData so the
// worker can use createRequire(serverDir) to find @resvg/resvg-js correctly.
//
// Constructor signature:
//   new RenderPool(workerPath, serverDir, size, resvgOpts)
//
//   workerPath — absolute path to core/renderWorker.js
//   serverDir  — dirname(fileURLToPath(import.meta.url)) from server.js/index.js
//   size       — number of worker threads (= MAX_CONCURRENT)
//   resvgOpts  — serialisable font/render config
//
// ── Crash-restart backoff ─────────────────────────────────────────────────────
// Without backoff, a broken import causes instant respawn → spawn storm → OOM.
// Each worker slot gets exponential backoff: 200ms → 400ms → … → 30s cap.
// Workers that stay alive >5s reset their failure count on next crash.
// MAX_PENDING_RESPAWNS=2 hard-caps queued respawns across all slots.

import { Worker } from 'node:worker_threads';

const HEALTHY_UPTIME_MS    = 5_000;
const BASE_BACKOFF_MS      =   200;
const MAX_BACKOFF_MS       = 30_000;
const MAX_PENDING_RESPAWNS =     2;

export class RenderPool {
  constructor(workerPath, serverDir, size, resvgOpts) {
    if (!workerPath) throw new Error('RenderPool: workerPath is required');
    if (!serverDir)  throw new Error('RenderPool: serverDir is required');

    this._workerPath      = workerPath;
    this._serverDir       = serverDir;
    this._resvgOpts       = resvgOpts;
    this._size            = size;
    this._workers         = [];
    this._queue           = [];
    this._inflight        = new Map();
    this._seq             = 0;
    this._failureCounts   = new Map();
    this._pendingRespawns = 0;

    for (let i = 0; i < size; i++) this._spawn(i);
  }

  _spawn(slot) {
    const spawnedAt = Date.now();
    const w = new Worker(this._workerPath, {
      workerData: {
        resvgOpts: this._resvgOpts,
        serverDir: this._serverDir,  // ← passed to createRequire in worker
      },
    });
    w._busy = false;
    w._wid  = ++this._seq;
    w._slot = slot;

    w.on('message', msg => {
      const prom = this._inflight.get(msg.jobId);
      this._inflight.delete(msg.jobId);
      w._busy = false;
      this._drain(w);
      if (!prom) return;
      if (msg.error) prom.reject(new Error(msg.error));
      else           prom.resolve({ buffer: Buffer.from(msg.buffer), mimeType: msg.mimeType });
    });

    w.on('error', err => {
      const n       = this._recordFailure(slot, Date.now() - spawnedAt);
      const backoff = this._calcBackoff(n);
      console.error(`[pool] Worker ${w._wid} slot=${slot} error — respawn in ${backoff}ms (fail #${n}): ${err.message}`);
      this._evict(w);
      this._scheduleRespawn(slot, backoff);
    });

    w.on('exit', code => {
      if (code === 0) return;
      const n       = this._recordFailure(slot, Date.now() - spawnedAt);
      const backoff = this._calcBackoff(n);
      console.error(`[pool] Worker ${w._wid} slot=${slot} exit ${code} — respawn in ${backoff}ms (fail #${n})`);
      this._evict(w);
      this._scheduleRespawn(slot, backoff);
    });

    this._workers.push(w);
  }

  _recordFailure(slot, uptimeMs) {
    if (uptimeMs >= HEALTHY_UPTIME_MS) this._failureCounts.delete(slot);
    const n = (this._failureCounts.get(slot) || 0) + 1;
    this._failureCounts.set(slot, n);
    return n;
  }

  _calcBackoff(failures) {
    const base   = Math.min(BASE_BACKOFF_MS * Math.pow(2, failures - 1), MAX_BACKOFF_MS);
    const jitter = base * 0.2 * Math.random();
    return Math.round(base + jitter);
  }

  _scheduleRespawn(slot, delayMs) {
    if (this._pendingRespawns >= MAX_PENDING_RESPAWNS) {
      console.warn(`[pool] slot=${slot} respawn skipped — ${this._pendingRespawns} already pending`);
      return;
    }
    this._pendingRespawns++;
    setTimeout(() => { this._pendingRespawns--; this._spawn(slot); }, delayMs);
  }

  _evict(w) {
    const idx = this._workers.indexOf(w);
    if (idx !== -1) this._workers.splice(idx, 1);
  }

  _dispatch(worker, job) {
    worker._busy = true;
    this._inflight.set(job.jobId, { resolve: job.resolve, reject: job.reject });
    worker.postMessage({ jobId: job.jobId, svgText: job.svgText, format: job.format });
  }

  _drain(worker) {
    if (this._queue.length > 0) this._dispatch(worker, this._queue.shift());
  }

  render(svgText, format = 'png') {
    return new Promise((resolve, reject) => {
      const jobId = ++this._seq;
      const free  = this._workers.find(w => !w._busy);
      if (free) this._dispatch(free, { jobId, svgText, format, resolve, reject });
      else      this._queue.push({ jobId, svgText, format, resolve, reject });
    });
  }

  get activeJobs()      { return this._workers.filter(w => w._busy).length; }
  get queuedJobs()      { return this._queue.length; }
  get workerCount()     { return this._workers.length; }
  get pendingRespawns() { return this._pendingRespawns; }

  async destroy() {
    await Promise.all(this._workers.map(w => w.terminate()));
    this._workers = [];
    this._queue   = [];
  }
}