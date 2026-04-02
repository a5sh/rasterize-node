// core/renderWorker.js
//
// Worker thread: SVG → raster.  Lives in core/ and is copied to {platform}/lib/
// by scripts/build.mjs so that createRequire resolves @resvg/resvg-js from the
// correct per-platform node_modules/.
//
// FAUX BOLD is applied here, inside the worker, so every render call is covered
// automatically.  Pool-callers (render/, vps/) do not need to call applyFauxBold
// themselves.  vercel/ and netlify/ call their own renderToBuffer which also
// applies it — the double-call is safe because hasStroke() short-circuits.

import { createRequire }          from 'node:module';
import { workerData, parentPort } from 'node:worker_threads';
import { applyFauxBold }          from './fauxBold.js';

// Resolve @resvg/resvg-js from the calling server's own node_modules/
const _require  = createRequire(workerData.serverDir + '/_.js');
const { Resvg } = _require('@resvg/resvg-js');

const OPTS = workerData.resvgOpts;

// ── Pre-warm ──────────────────────────────────────────────────────────────────
// One render at spawn time so V8 JIT-compiles the hot path before real traffic.

const WARMUP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750" viewBox="0 0 500 750">
  <rect width="500" height="750" fill="#1a1a1a"/>
  <rect x="30" y="30" width="140" height="60" rx="12" fill="rgba(0,0,0,0.45)"/>
  <text x="100" y="61" dominant-baseline="middle" text-anchor="middle"
        font-family="Noto Sans,Arial,sans-serif" font-size="28"
        font-weight="bold" fill="#ffffff">8.5</text>
  <rect x="30" y="110" width="140" height="60" rx="12" fill="rgba(0,0,0,0.45)"/>
  <text x="100" y="141" dominant-baseline="middle" text-anchor="middle"
        font-family="Noto Sans,Arial,sans-serif" font-size="28"
        font-weight="bold" fill="#ffffff">94%</text>
</svg>`;

try {
  const warmSvg = applyFauxBold(WARMUP_SVG);
  new Resvg(warmSvg, OPTS).render().asPng();
} catch (e) {
  console.warn('[worker] Pre-warm failed (non-fatal):', e.message);
}

// ── Message handler ───────────────────────────────────────────────────────────

parentPort.on('message', ({ jobId, svgText, format }) => {
  try {
    // Apply faux bold here so all pool-based platforms are covered in one place.
    const processed = applyFauxBold(svgText);
    const resvg     = new Resvg(processed, OPTS);
    const rendered  = resvg.render();

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

    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    parentPort.postMessage({ jobId, buffer: ab, mimeType: mime }, [ab]);
  } catch (err) {
    parentPort.postMessage({ jobId, error: err.message });
  }
});