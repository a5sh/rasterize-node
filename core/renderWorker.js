// core/renderWorker.js
//
// Runs inside a worker_thread.  The main thread is NEVER blocked by rendering.
//
// Lifecycle:
//   1. Receive { resvgOpts } via workerData at spawn time
//   2. Pre-warm: render one real-shaped SVG to force V8 JIT compilation
//      before the first live request arrives
//   3. Listen for { jobId, svgText, format } messages
//   4. Post back { jobId, buffer (transferred ArrayBuffer), mimeType }
//      — or { jobId, error } on failure
//
// Buffer transfer strategy:
//   resvg-js returns a Node.js Buffer whose .buffer is a V8 ArrayBuffer.
//   Node.js Buffers from small allocations share a pooled ArrayBuffer
//   (byteOffset may be non-zero).  We always slice() to obtain a standalone
//   ArrayBuffer before transferring so the Structured Clone algorithm can
//   use a zero-copy move rather than a memcpy.

import { workerData, parentPort } from 'node:worker_threads';
import { Resvg }                  from '@resvg/resvg-js';

const OPTS = workerData.resvgOpts;

// ── Pre-warm ──────────────────────────────────────────────────────────────────
//
// Rendering the first SVG after a cold start is ~2–4× slower than subsequent
// renders because V8 hasn't JIT-compiled the resvg-js hot paths yet.
// We render a poster-shaped SVG (text, rect, preserve-aspect-ratio) here so
// the very first real user request hits already-compiled code.

const WARMUP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750" viewBox="0 0 500 750">
  <rect width="500" height="750" fill="#1a1a1a"/>
  <rect x="30" y="30" width="140" height="60" rx="12" fill="rgba(0,0,0,0.45)"/>
  <text x="100" y="61" dominant-baseline="middle" text-anchor="middle"
        font-family="Arial,'Helvetica Neue',sans-serif" font-size="28"
        font-weight="bold" fill="#ffffff">8.5</text>
  <rect x="30" y="110" width="140" height="60" rx="12" fill="rgba(0,0,0,0.45)"/>
  <text x="100" y="141" dominant-baseline="middle" text-anchor="middle"
        font-family="Arial,'Helvetica Neue',sans-serif" font-size="28"
        font-weight="bold" fill="#ffffff">94%</text>
</svg>`;

try {
  new Resvg(WARMUP_SVG, OPTS).render().asPng();
} catch (_) {
  // Font config or resvg issue — don't crash the worker, log and continue.
  // The first real render may be slow but will still work.
  console.warn('[worker] Pre-warm failed (non-fatal):', _.message);
}

// ── Message handler ───────────────────────────────────────────────────────────

parentPort.on('message', ({ jobId, svgText, format }) => {
  try {
    const resvg    = new Resvg(svgText, OPTS);
    const rendered = resvg.render();

    let buf, mime;

    if ((format === 'jpg' || format === 'jpeg') && typeof rendered.asJpeg === 'function') {
      buf  = rendered.asJpeg(85);
      mime = 'image/jpeg';
    } else if (format === 'webp' && typeof rendered.asWebp === 'function') {
      buf  = rendered.asWebp(85);
      mime = 'image/webp';
    } else {
      buf  = rendered.asPng();
      mime = 'image/png';
    }

    // buf is a Node.js Buffer — its .buffer ArrayBuffer may be a shared pool
    // with a non-zero byteOffset.  slice() creates an independent ArrayBuffer
    // so postMessage() can *transfer* it (zero-copy) instead of cloning it.
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    parentPort.postMessage({ jobId, buffer: ab, mimeType: mime }, [ab]);

  } catch (err) {
    parentPort.postMessage({ jobId, error: err.message });
  }
});