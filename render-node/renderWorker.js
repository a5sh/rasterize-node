// render-node/renderWorker.js   (also copy to node/renderWorker.js)
//
// IMPORTANT — this file must live in the SAME DIRECTORY as server.js / index.js,
// not in core/.  Node.js resolves `import '@resvg/resvg-js'` relative to this
// file's location.  Placing it next to server.js puts it next to node_modules/,
// so the package is always found regardless of the project's root structure.
//
// Lifecycle:
//   1. Spawned by RenderPool with { resvgOpts } in workerData
//   2. Pre-warms V8 JIT by rendering one poster-shaped SVG at startup
//   3. Processes { jobId, svgText, format } messages, posts back
//      { jobId, buffer (transferred ArrayBuffer), mimeType } or { jobId, error }

import { workerData, parentPort } from 'node:worker_threads';
import { Resvg }                  from '@resvg/resvg-js';

const OPTS = workerData.resvgOpts;

// ── Pre-warm ──────────────────────────────────────────────────────────────────
// V8 JIT-compiles Resvg's hot paths after the first render.  Running a dummy
// render at spawn time means the very first real request hits compiled code.
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

    // slice() produces a standalone ArrayBuffer so postMessage can *transfer*
    // it (zero-copy move) instead of structured-clone copying it.
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    parentPort.postMessage({ jobId, buffer: ab, mimeType: mime }, [ab]);

  } catch (err) {
    parentPort.postMessage({ jobId, error: err.message });
  }
});