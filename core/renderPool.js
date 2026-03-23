// core/renderPool.js
//
// Fixed-size pool of worker_threads for CPU-bound SVG → raster rendering.
//
// WHY WORKER THREADS:
//   Resvg.render() is a synchronous, CPU-bound native call.  Running it on the
//   main thread blocks the entire Node.js event loop — no other requests can be
//   accepted, read, or responded to until the render finishes.
//   With a worker pool, the event loop stays free to handle I/O (body reads,
//   wsrv fallbacks, health checks, Discord webhooks) concurrently with renders.
//
// POOL MECHANICS:
//   • N workers are spawned at startup (N = MAX_CONCURRENT, default = cpu count)
//   • Each worker renders one job at a time (its own synchronous call stack)
//   • Overflow jobs queue in-process; dispatched the moment a worker frees up
//   • Workers crash-restart automatically; in-flight job receives an error
//   • ArrayBuffers are *transferred* (zero-copy) from worker to main thread
//
// USAGE:
//   const pool = new RenderPool(numWorkers, resvgOpts);
//   const { buffer, mimeType } = await pool.render(svgText, 'png');

import { Worker }        from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'renderWorker.js');

export class RenderPool {
  /**
   * @param {number} size       Number of worker threads to maintain
   * @param {object} resvgOpts  Serialisable resvg-js options (font config, fitTo, etc.)
   */
  constructor(size, resvgOpts) {
    this._resvgOpts = resvgOpts;
    this._size      = size;
    this._workers   = [];
    this._queue     = [];          // Array<PendingJob>
    this._inflight  = new Map();   // jobId → { resolve, reject }
    this._seq       = 0;

    for (let i = 0; i < size; i++) this._spawn();
  }

  // ── Worker lifecycle ───────────────────────────────────────────────────────

  _spawn() {
    const w   = new Worker(WORKER_PATH, { workerData: { resvgOpts: this._resvgOpts } });
    w._busy   = false;
    w._wid    = ++this._seq; // internal id for logging

    w.on('message', (msg) => {
      const prom = this._inflight.get(msg.jobId);
      this._inflight.delete(msg.jobId);
      w._busy = false;

      // Drain the queue *before* resolving — keeps the worker hot and avoids
      // an extra event-loop tick before the next job starts.
      this._drain(w);

      if (!prom) return; // job was cancelled or worker was replaced

      if (msg.error) {
        prom.reject(new Error(msg.error));
      } else {
        // Buffer.from(ArrayBuffer) creates a view with no copy.
        prom.resolve({ buffer: Buffer.from(msg.buffer), mimeType: msg.mimeType });
      }
    });

    w.on('error', (err) => {
      console.error(`[pool] Worker ${w._wid} error — respawning:`, err.message);
      this._evict(w);
      this._spawn();
    });

    w.on('exit', (code) => {
      if (code !== 0) {
        console.error(`[pool] Worker ${w._wid} exited with code ${code} — respawning`);
        this._evict(w);
        this._spawn();
      }
    });

    this._workers.push(w);
  }

  _evict(w) {
    const idx = this._workers.indexOf(w);
    if (idx !== -1) this._workers.splice(idx, 1);
  }

  // ── Dispatch ───────────────────────────────────────────────────────────────

  _dispatch(worker, job) {
    worker._busy = true;
    this._inflight.set(job.jobId, { resolve: job.resolve, reject: job.reject });
    worker.postMessage({ jobId: job.jobId, svgText: job.svgText, format: job.format });
  }

  _drain(worker) {
    if (this._queue.length > 0) this._dispatch(worker, this._queue.shift());
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Render svgText → raster image.
   *
   * Resolves with { buffer: Buffer, mimeType: string }.
   * Rejects if resvg throws (caller should wsrv-fallback).
   *
   * @param {string} svgText
   * @param {string} [format='png']  'png' | 'jpg' | 'jpeg' | 'webp'
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

  /** Workers currently rendering. */
  get activeJobs() { return this._workers.filter(w => w._busy).length; }

  /** Jobs waiting for a free worker slot. */
  get queuedJobs() { return this._queue.length; }

  /** Live worker count (may be < size briefly during a crash-restart). */
  get workerCount() { return this._workers.length; }

  /** Graceful shutdown — terminate all workers. */
  async destroy() {
    await Promise.all(this._workers.map(w => w.terminate()));
    this._workers = [];
    this._queue   = [];
  }
}