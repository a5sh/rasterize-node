// core/renderWorker.js
//
// Worker thread for CPU-bound SVG → raster rendering.
// Stays in core/ — no need to copy it anywhere.
//
// ── WHY createRequire ─────────────────────────────────────────────────────────
// Node ESM resolves `import '@resvg/resvg-js'` relative to THIS file's path.
// This file lives in core/, but node_modules/ is in render-node/ (or node/).
// Walking up from core/ never reaches render-node/node_modules/.
//
// Fix: renderPool passes workerData.serverDir = the calling server's __dirname
// (i.e. render-node/ or node/).  We use createRequire() with that directory
// so @resvg/resvg-js is resolved from the correct node_modules — regardless
// of where this worker script physically lives.

import { createRequire }          from 'node:module';
import { workerData, parentPort } from 'node:worker_threads';

// Load @resvg/resvg-js from the server's own node_modules/
// createRequire expects a file path (not a directory), so append /_.js
const _require  = createRequire(workerData.serverDir + '/_.js');
const { Resvg } = _require('@resvg/resvg-js');

const OPTS = workerData.resvgOpts;

// ── Pre-warm ──────────────────────────────────────────────────────────────────
// Render one poster-shaped SVG at spawn time so V8 JIT-compiles the hot paths
// before the first real request arrives. Non-fatal if it fails.

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
} catch (e) {
  console.warn('[worker] Pre-warm failed (non-fatal):', e.message);
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

    // slice() → standalone ArrayBuffer → zero-copy postMessage transfer
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    parentPort.postMessage({ jobId, buffer: ab, mimeType: mime }, [ab]);

  } catch (err) {
    parentPort.postMessage({ jobId, error: err.message });
  }
});