// core/renderWorker.js
//
// Worker thread: SVG → raster via @resvg/resvg-js.
//
// KEY CHANGE: Message handler is now async to support embedExternalImages().
// When the SVG contains href="https://..." image references (URL-based poster),
// we fetch and embed them as base64 before passing to resvg, which cannot
// resolve external URLs on its own.
//
// This keeps the HTTP transfer from CF Worker → rasterizer tiny (~5-10KB SVG
// instead of 300-600KB with base64-embedded poster), and the rasterizer fetches
// the poster image directly from TMDB's CDN which is globally distributed.
//
// FAUX BOLD is applied here so all pool-based platforms are covered.

import { createRequire }          from 'node:module';
import { workerData, parentPort } from 'node:worker_threads';
import { applyFauxBold }          from './fauxBold.js';

const _require  = createRequire(workerData.serverDir + '/_.js');
const { Resvg } = _require('@resvg/resvg-js');

const OPTS = workerData.resvgOpts;

// ── Pre-warm ──────────────────────────────────────────────────────────────────

const WARMUP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750" viewBox="0 0 500 750">
  <rect width="500" height="750" fill="#1a1a1a"/>
  <rect x="30" y="30" width="140" height="60" rx="12" fill="rgba(0,0,0,0.45)"/>
  <text x="100" y="61" dominant-baseline="middle" text-anchor="middle"
        font-family="Noto Sans,Arial,sans-serif" font-size="28"
        font-weight="bold" fill="#ffffff">8.5</text>
</svg>`;

try {
  const warmSvg = applyFauxBold(WARMUP_SVG);
  new Resvg(warmSvg, OPTS).render().asPng();
} catch (e) {
  console.warn('[worker] Pre-warm failed (non-fatal):', e.message);
}

// ── External image embedding ──────────────────────────────────────────────────
// Replaces href="https://..." with inline base64 data URIs so resvg can render
// the poster image without filesystem or network access.
//
// Called ONLY when the SVG contains URL references (no_embed or URL-based path).
// When the poster is already base64, this is a no-op (no matches).

const EXTERNAL_IMG_RE = /href="(https?:\/\/[^"]+)"/g;
const FETCH_TIMEOUT_MS = 6_000;

async function embedExternalImages(svgText) {
  const matches = [...svgText.matchAll(EXTERNAL_IMG_RE)];
  if (matches.length === 0) return svgText;

  const uniqueUrls = [...new Set(matches.map(m => m[1]))];

  const replacements = await Promise.all(
    uniqueUrls.map(async url => {
      const ac = new AbortController();
      const t  = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          signal:  ac.signal,
          headers: { 'User-Agent': 'SpicyDevs-Rasterizer/4.0' },
        });
        clearTimeout(t);
        if (!res.ok) return { url, dataUri: null };

        const buf = Buffer.from(await res.arrayBuffer());
        const ct  = res.headers.get('content-type') || 'image/jpeg';
        return { url, dataUri: `data:${ct};base64,${buf.toString('base64')}` };
      } catch {
        clearTimeout(t);
        return { url, dataUri: null };
      }
    }),
  );

  for (const { url, dataUri } of replacements) {
    if (dataUri) {
      svgText = svgText.split(`href="${url}"`).join(`href="${dataUri}"`);
    }
  }
  return svgText;
}

// ── Message handler ───────────────────────────────────────────────────────────

parentPort.on('message', async ({ jobId, svgText, format }) => {
  try {
    // Step 1: embed external poster images (no-op if already base64)
    const embedded = await embedExternalImages(svgText);

    // Step 2: apply faux bold
    const processed = applyFauxBold(embedded);

    // Step 3: render
    const resvg    = new Resvg(processed, OPTS);
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

    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    parentPort.postMessage({ jobId, buffer: ab, mimeType: mime }, [ab]);
  } catch (err) {
    parentPort.postMessage({ jobId, error: err.message });
  }
});