// netlify-node/netlify/functions/rasterize.js
//
// CHANGES vs previous version
// ─────────────────────────────
// • FAUX BOLD: applyFauxBold() applied before every renderToBuffer() call.
//   NotoSans-Subset.ttf is Regular-only; without this, bold text renders thin.

import fs               from 'node:fs';
import os               from 'node:os';
import path             from 'node:path';
import { Resvg }        from '@resvg/resvg-js';
import { FONT_BUFFER }  from '../../lib/font-data.js';
import { applyFauxBold } from '../../core/fauxBold.js';

// ── Font setup ────────────────────────────────────────────────────────────────
const TMP_FONT_PATH = path.join(os.tmpdir(), 'NotoSans-Subset.ttf');

function ensureFont() {
  try {
    fs.writeFileSync(TMP_FONT_PATH, FONT_BUFFER);
  } catch (e) {
    if (!fs.existsSync(TMP_FONT_PATH)) throw e;
  }
}

let fontReady = false;
try {
  ensureFont();
  fontReady = true;
} catch (e) {
  console.error('[font] Failed to write font to /tmp:', e.message);
}

const RESVG_OPTS = {
  fitTo:          { mode: 'original' },
  imageRendering: 0,
  font: {
    loadSystemFonts:   false,
    defaultFontFamily: 'Noto Sans',
    sansSerifFamily:   'Noto Sans',
    serifFamily:       'Noto Sans',
    monospaceFamily:   'Noto Sans',
    ...(fontReady ? { fontFiles: [TMP_FONT_PATH] } : {}),
  },
};

// ── Render helpers ────────────────────────────────────────────────────────────

function renderToBuffer(svgText, format) {
  // Apply faux bold before rendering — netlify ships Regular TTF only.
  const processedSvg = applyFauxBold(svgText);
  const resvg    = new Resvg(processedSvg, RESVG_OPTS);
  const rendered = resvg.render();
  if ((format === 'jpg' || format === 'jpeg') && typeof rendered.asJpeg === 'function') {
    return { buffer: rendered.asJpeg(85), mimeType: 'image/jpeg' };
  }
  if (format === 'webp' && typeof rendered.asWebp === 'function') {
    return { buffer: rendered.asWebp(85), mimeType: 'image/webp' };
  }
  return { buffer: rendered.asPng(), mimeType: 'image/png' };
}

async function fetchFromWsrv(svgUrl, format) {
  const url = new URL('https://wsrv.nl/');
  url.searchParams.set('url',    svgUrl);
  url.searchParams.set('output', format === 'webp' ? 'webp' : format === 'png' ? 'png' : 'jpg');
  url.searchParams.set('q',      '100');
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), 6_000);
  try {
    const res = await fetch(url.toString(), {
      signal:  ac.signal,
      headers: { 'User-Agent': 'SpicyDevs-Rasterizer/2.0' },
    });
    if (!res.ok) throw new Error(`wsrv.nl returned ${res.status}`);
    return res;
  } finally {
    clearTimeout(t);
  }
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResp(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body:    JSON.stringify(body),
  };
}

function imageResp(buffer, mimeType) {
  return {
    statusCode:       200,
    headers:          { 'Content-Type': mimeType, 'Cache-Control': 'public, max-age=86400', ...CORS },
    body:             Buffer.from(buffer).toString('base64'),
    isBase64Encoded:  true,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const pathname = (event.path || '/').split('?')[0];
  if (pathname === '/health') {
    return jsonResp(200, { status: 'ok', version: '2.3', fontReady, fontFile: TMP_FONT_PATH });
  }

  const contentType = event.headers['content-type'] || '';

  // ── JSON path ─────────────────────────────────────────────────────────────
  if (contentType.includes('application/json')) {
    const bodyStr = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf-8')
      : (event.body || '');

    if (!bodyStr) return jsonResp(400, { error: 'Empty body' });

    let payload;
    try { payload = JSON.parse(bodyStr); }
    catch { return jsonResp(400, { error: 'Invalid JSON' }); }

    // Single job
    if (payload.svgText) {
      const fmt = payload.format || 'png';
      try {
        const { buffer, mimeType } = renderToBuffer(payload.svgText, fmt);
        return imageResp(buffer, mimeType);
      } catch (resvgErr) {
        console.error('[resvg] single render failed:', resvgErr.message);
        const svgFallback = payload.svgUrl || null;
        if (svgFallback) {
          try {
            const wsrvRes = await fetchFromWsrv(svgFallback, fmt);
            const buf  = Buffer.from(await wsrvRes.arrayBuffer());
            const mime = wsrvRes.headers.get('content-type') || 'image/png';
            return imageResp(buf, mime);
          } catch (wsrvErr) {
            return jsonResp(502, { error: `resvg: ${resvgErr.message} | wsrv: ${wsrvErr.message}` });
          }
        }
        return jsonResp(500, { error: resvgErr.message });
      }
    }

    // Bulk
    if (!Array.isArray(payload.jobs)) {
      return jsonResp(400, { error: 'Expected { svgText } for single render or { jobs: [] } for bulk' });
    }

    const results = await Promise.all(payload.jobs.map(async (job) => {
      const fmt = job.format || 'png';
      try {
        const { buffer, mimeType } = renderToBuffer(job.svgText, fmt);
        return { id: job.id, status: 'success', mimeType, data: Buffer.from(buffer).toString('base64') };
      } catch (resvgErr) {
        if (job.svgUrl) {
          try {
            const wsrvRes = await fetchFromWsrv(job.svgUrl, fmt);
            const buf  = Buffer.from(await wsrvRes.arrayBuffer());
            const mime = wsrvRes.headers.get('content-type') || 'image/png';
            return { id: job.id, status: 'success', mimeType: mime, data: buf.toString('base64') };
          } catch (wsrvErr) {
            return { id: job.id, status: 'error', error: `resvg: ${resvgErr.message} | wsrv: ${wsrvErr.message}` };
          }
        }
        return { id: job.id, status: 'error', error: resvgErr.message };
      }
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
      body: JSON.stringify({ results }),
    };
  }

  // ── Legacy: GET ?url= or POST raw SVG body ────────────────────────────────
  const params      = new URLSearchParams(event.rawQuery || '');
  const format      = params.get('format') || 'png';
  const svgFallback = params.get('fallback_url') || null;

  let svgText;

  if (event.httpMethod === 'GET') {
    const targetUrl = params.get('url');
    if (!targetUrl) return jsonResp(400, { error: 'Missing ?url= parameter' });
    try {
      const res = await fetch(targetUrl, {
        headers: { 'User-Agent': 'SpicyDevs-Rasterizer/2.0' },
        signal:  AbortSignal.timeout(8_000),
      });
      if (!res.ok) return jsonResp(502, { error: `SVG fetch failed: ${res.status}` });
      svgText = await res.text();
    } catch (e) {
      return jsonResp(502, { error: `SVG fetch threw: ${e.message}` });
    }
  } else if (event.httpMethod === 'POST') {
    svgText = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf-8')
      : (event.body || '');
    if (!svgText) return jsonResp(400, { error: 'Empty SVG body' });
  } else {
    return jsonResp(405, { error: 'Method not allowed' });
  }

  try {
    const { buffer, mimeType } = renderToBuffer(svgText, format);
    return imageResp(buffer, mimeType);
  } catch (resvgErr) {
    console.error('[resvg] legacy render failed:', resvgErr.message);
    if (svgFallback) {
      try {
        const wsrvRes = await fetchFromWsrv(svgFallback, format);
        const buf  = Buffer.from(await wsrvRes.arrayBuffer());
        const mime = wsrvRes.headers.get('content-type') || 'image/png';
        return imageResp(buf, mime);
      } catch (wsrvErr) {
        return jsonResp(502, { error: `resvg: ${resvgErr.message} | wsrv: ${wsrvErr.message}` });
      }
    }
    return jsonResp(500, { error: resvgErr.message });
  }
};