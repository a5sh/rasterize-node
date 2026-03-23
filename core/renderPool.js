// core/renderPool.js
//
// Fixed-size pool of worker_threads for CPU-bound SVG → raster rendering.
//
// ── CRITICAL: workerPath must be co-located with node_modules ─────────────────
// Node.js resolves `import '@resvg/resvg-js'` relative to the WORKER FILE's
// location, not the main process.  Pass an absolute path to a renderWorker.js
// that sits next to the package's node_modules/ directory.
//
// ── Crash-restart backoff ─────────────────────────────────────────────────────
// When workers fail immediately (e.g. import error, wrong path), naive
// instant-respawn causes a spawn storm: each spawn loads the Node runtime +
// resvg WASM (~80 MB) before dying, hundreds of times per second → OOM.
//
// Fix: exponential backoff with jitter on each consecutive failure.
// A worker that runs successfully for > HEALTHY_UPTIME_MS resets its backoff.
//
// Backoff schedule (per worker slot):
//   failure 1 → 200 ms
//   failure 2 → 400 ms
//   failure 3 → 800 ms
//   ...
//   failure N → min(200 * 2^N, 30_000) ms  +  up to 20% random jitter
//
// MAX_PENDING_RESPAWNS caps the number of workers waiting to be respawned.
// If all slots are in backoff simultaneously (total startup failure), no more
// spawns are scheduled until one resolves.

import { Worker } from 'node:worker_threads';

const HEALTHY_UPTIME_MS   = 5_000;   // reset backoff if worker lived this long
const BASE_BACKOFF_MS     =   200;
const MAX_BACKOFF_MS      = 30_000;
const MAX_PENDING_RESPAWNS = 2;       // never queue more than this many delayed respawns

export class RenderPool {
  /**
   * @param {string} workerPath  Absolute path to renderWorker.js (next to node_modules/)
   * @param {number} size        Number of worker threads
   * @param {object} resvgOpts   Serialisable resvg-js options passed via workerData
   */
  constructor(workerPath, size, resvgOpts) {
    if (!workerPath) throw new Error('RenderPool: workerPath is required');

    this._workerPath      = workerPath;
    this._resvgOpts       = resvgOpts;
    this._size            = size;
    this._workers         = [];
    this._queue           = [];
    this._inflight        = new Map();
    this._seq             = 0;
    this._failureCounts   = new Map();  // slot index → consecutive failure count
    this._pendingRespawns = 0;

    for (let i = 0; i < size; i++) this._spawn(i);
  }

  // ── Worker lifecycle ─────────────────────────────────────────────────────────

  _spawn(slot) {
    const spawnedAt = Date.now();
    const w         = new Worker(this._workerPath, { workerData: { resvgOpts: this._resvgOpts } });
    w._busy  = false;
    w._wid   = ++this._seq;
    w._slot  = slot;

    w.on('message', msg => {
      const prom = this._inflight.get(msg.jobId);
      this._inflight.delete(msg.jobId);
      w._busy = false;

      this._drain(w);

      if (!prom) return;
      if (msg.error) {
        prom.reject(new Error(msg.error));
      } else {
        prom.resolve({ buffer: Buffer.from(msg.buffer), mimeType: msg.mimeType });
      }
    });

    w.on('error', err => {
      const uptime = Date.now() - spawnedAt;
      if (uptime >= HEALTHY_UPTIME_MS) {
        this._failureCounts.delete(slot);  // reset: it was healthy before
      }
      const failures = (this._failureCounts.get(slot) || 0) + 1;
      this._failureCounts.set(slot, failures);

      const backoff = this._calcBackoff(failures);
      console.error(
        `[pool] Worker ${w._wid} (slot ${slot}) error — respawning in ${backoff}ms (failure #${failures}):`,
        err.message,
      );

      this._evict(w);
      this._scheduleRespawn(slot, backoff);
    });

    w.on('exit', code => {
      if (code === 0) return;  // clean exit during destroy()

      const uptime = Date.now() - spawnedAt;
      if (uptime >= HEALTHY_UPTIME_MS) {
        this._failureCounts.delete(slot);
      }
      const failures = (this._failureCounts.get(slot) || 0) + 1;
      this._failureCounts.set(slot, failures);

      const backoff = this._calcBackoff(failures);
      console.error(
        `[pool] Worker ${w._wid} (slot ${slot}) exited code ${code} — respawning in ${backoff}ms (failure #${failures})`,
      );

      this._evict(w);
      this._scheduleRespawn(slot, backoff);
    });

    this._workers.push(w);
    return w;
  }

  _calcBackoff(failures) {
    const base  = Math.min(BASE_BACKOFF_MS * Math.pow(2, failures - 1), MAX_BACKOFF_MS);
    const jitter = base * 0.2 * Math.random();  // up to 20% jitter
    return Math.round(base + jitter);
  }

  _scheduleRespawn(slot, delayMs) {
    if (this._pendingRespawns >= MAX_PENDING_RESPAWNS) {
      // Too many pending respawns already — skip this one.
      // The slot stays empty; once a pending respawn succeeds it will serve requests.
      console.warn(`[pool] Slot ${slot} respawn skipped — ${this._pendingRespawns} already pending`);
      return;
    }

    this._pendingRespawns++;
    setTimeout(() => {
      this._pendingRespawns--;
      this._spawn(slot);
    }, delayMs);
  }

  _evict(w) {
    const idx = this._workers.indexOf(w);
    if (idx !== -1) this._workers.splice(idx, 1);
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────────

  _dispatch(worker, job) {
    worker._busy = true;
    this._inflight.set(job.jobId, { resolve: job.resolve, reject: job.reject });
    worker.postMessage({ jobId: job.jobId, svgText: job.svgText, format: job.format });
  }

  _drain(worker) {
    if (this._queue.length > 0) this._dispatch(worker, this._queue.shift());
  }

  /**
   * Render svgText to a raster image off the main thread.
   * @param {string} svgText
   * @param {string} [format='png']
   * @returns {Promise<{ buffer: Buffer, mimeType: string }>}
   */
  render(svgText, format = 'png') {
    return new Promise((resolve, reject) => {
      const jobId = ++this._seq;
      const free  = this._workers.find(w => !w._busy);
      if (free) {
        this._dispatch(free, { jobId, svgText, format, resolve, reject });
      } else {
        this._queue.push({ jobId, svgText, format, resolve, reject });
      }
    });
  }

  get activeJobs()       { return this._workers.filter(w => w._busy).length; }
  get queuedJobs()       { return this._queue.length; }
  get workerCount()      { return this._workers.length; }
  get pendingRespawns()  { return this._pendingRespawns; }

  async destroy() {
    await Promise.all(this._workers.map(w => w.terminate()));
    this._workers = [];
    this._queue   = [];
  }
}