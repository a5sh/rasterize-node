// core/renderPool.js
//
// Fixed-size pool of worker_threads for CPU-bound SVG → raster rendering.
//
// WHY workerPath IS A CONSTRUCTOR ARGUMENT:
//   Node.js resolves `import '@resvg/resvg-js'` relative to the WORKER FILE's
//   location on disk, not the main process's cwd or the pool file's location.
//   If renderWorker.js lived in core/ but node_modules is in render-node/, the
//   workers would crash with "Cannot find package '@resvg/resvg-js'".
//
//   Solution: the worker script (renderWorker.js) sits in the same directory as
//   server.js — right next to node_modules.  server.js passes its absolute path
//   to RenderPool so the pool stays generic and reusable across deployments.
//
// USAGE (server.js):
//   import { fileURLToPath } from 'node:url';
//   import { dirname, join } from 'node:path';
//   const WORKER = join(dirname(fileURLToPath(import.meta.url)), 'renderWorker.js');
//   pool = new RenderPool(WORKER, MAX_CONCURRENT, resvgOpts);

import { Worker } from 'node:worker_threads';

export class RenderPool {
  /**
   * @param {string} workerPath  Absolute path to the worker script (renderWorker.js)
   * @param {number} size        Number of worker threads
   * @param {object} resvgOpts   Serialisable resvg-js options passed via workerData
   */
  constructor(workerPath, size, resvgOpts) {
    if (!workerPath) throw new Error('RenderPool: workerPath is required');

    this._workerPath = workerPath;
    this._resvgOpts  = resvgOpts;
    this._size       = size;
    this._workers    = [];
    this._queue      = [];
    this._inflight   = new Map();
    this._seq        = 0;

    for (let i = 0; i < size; i++) this._spawn();
  }

  _spawn() {
    const w  = new Worker(this._workerPath, { workerData: { resvgOpts: this._resvgOpts } });
    w._busy  = false;
    w._wid   = ++this._seq;

    w.on('message', msg => {
      const prom = this._inflight.get(msg.jobId);
      this._inflight.delete(msg.jobId);
      w._busy = false;
      // Drain queue before resolving — keeps the worker hot, avoids extra event-loop tick
      this._drain(w);
      if (!prom) return;
      if (msg.error) {
        prom.reject(new Error(msg.error));
      } else {
        // Buffer.from(ArrayBuffer) is a zero-copy view
        prom.resolve({ buffer: Buffer.from(msg.buffer), mimeType: msg.mimeType });
      }
    });

    w.on('error', err => {
      console.error(`[pool] Worker ${w._wid} error — respawning:`, err.message);
      this._evict(w);
      this._spawn();
    });

    w.on('exit', code => {
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

  get activeJobs()  { return this._workers.filter(w => w._busy).length; }
  get queuedJobs()  { return this._queue.length; }
  get workerCount() { return this._workers.length; }

  async destroy() {
    await Promise.all(this._workers.map(w => w.terminate()));
    this._workers = [];
    this._queue   = [];
  }
}