// netlify/functions/rasterize.js
//
// Netlify Function — SVG → raster via @resvg/resvg-js.
//
// lib/ is populated by the build command:
//   node ../../scripts/build.mjs netlify
// which copies core/{fauxBold,sharedRender,renderPool,renderWorker,NotoSans-Subset.ttf}
// into netlify/lib/.
//
// FONT + BOLD STRATEGY (same on every platform)
// ──────────────────────────────────────────────
// • NotoSans-Subset.ttf (Regular only) — no system bold variants loaded.
// • applyFauxBold() synthesises bold via a calibrated 0.035em stroke so
//   output matches wsrv.nl/librsvg reference visually on all nodes.

import fs               from 'node:fs';
import os               from 'node:os';
import path             from 'node:path';
import { Resvg }        from '@resvg/resvg-js';
import { applyFauxBold } from '../lib/fauxBold.js';
import { buildResvgOpts } from '../lib/sharedRender.js';

const RESVG_OPTS = buildResvgOpts();

// ── Render ────────────────────────────────────────────────────────────────────

function renderToBuffer(svgText, format) {
  const processed = applyFauxBold(svgText);
  const resvg     = new Resvg(processed, RESVG_OPTS);
  const rendered  = resvg.render();
  if ((format === 'jpg' || format === 'jpeg') && typeof rendered.asJpeg === 'function') {
    return { buffer: rendered.asJpeg(85), mimeType: 'image/jpeg' };
  }
  if (format === 'webp' && typeof rendered.asWebp === 'function') {
    return { buffer: rendered.asWebp(85), mimeType: 'image/webp' };
  }
  return { buffer: rendered.asPng(), mimeType: 'image/png' };
}

async function fetchFromWsrv(svgUrl, format) {
  const u = new URL('https://wsrv.nl/');
  u.searchParams.set('url',    svgUrl);
  u.searchParams.set('output', format === 'webp' ? 'webp' : format === 'png' ? 'png' : 'jpg');
  u.searchParams.set('q',      '100');
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), 6_000);
  try {
    const res = await fetch(u.toString(), {
      signal:  ac.signal,
      headers: { 'User-Agent': 'SpicyDevs-Rasterizer/3.0' },
    });
    if (!res.ok) throw new Error(`wsrv.nl returned ${res.status}`);
    return res;
  } finally { clearTimeout(t); }
}

// ── Response helpers ──────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const jsonResp  = (code, body) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', ...CORS }, body: JSON.stringify(body) });
const imageResp = (buf, mime)  => ({ statusCode: 200, headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400', ...CORS }, body: Buffer.from(buf).toString('base64'), isBase64Encoded: true });

// ── Handler ───────────────────────────────────────────────────────────────────

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const pathname = (event.path || '/').split('?')[0];

  if (pathname === '/health') {
    return jsonResp(200, { status: 'ok', version: '3.0', node: 'netlify', fontReady: RESVG_OPTS.font?.fontFiles?.length > 0 });
  }

  const ct      = event.headers['content-type'] || '';
  const params  = new URLSearchParams(event.rawQuery || '');
  const format  = params.get('format') || 'png';

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf-8')
    : (event.body || '');

  // ── JSON path ─────────────────────────────────────────────────────────────
  if (ct.includes('application/json')) {
    if (!rawBody) return jsonResp(400, { error: 'Empty body' });

    let payload;
    try { payload = JSON.parse(rawBody); }
    catch { return jsonResp(400, { error: 'Invalid JSON' }); }

    // Single job
    if (payload.svgText) {
      const fmt = payload.format || format;
      try {
        const { buffer, mimeType } = renderToBuffer(payload.svgText, fmt);
        return imageResp(buffer, mimeType);
      } catch (resvgErr) {
        if (payload.svgUrl) {
          try {
            const wsrvRes = await fetchFromWsrv(payload.svgUrl, fmt);
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
      return jsonResp(400, { error: 'Expected { svgText } or { jobs: [] }' });
    }

    const results = await Promise.all(payload.jobs.map(async job => {
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

    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS }, body: JSON.stringify({ results }) };
  }

  // ── Legacy: GET ?url= or POST raw SVG ─────────────────────────────────────
  let svgText;

  if (event.httpMethod === 'GET') {
    const targetUrl = params.get('url');
    if (!targetUrl) return jsonResp(400, { error: 'Missing ?url= parameter' });
    try {
      const res = await fetch(targetUrl, { headers: { 'User-Agent': 'SpicyDevs-Rasterizer/3.0' }, signal: AbortSignal.timeout(8_000) });
      if (!res.ok) return jsonResp(502, { error: `SVG fetch failed: ${res.status}` });
      svgText = await res.text();
    } catch (e) {
      return jsonResp(502, { error: `SVG fetch threw: ${e.message}` });
    }
  } else if (event.httpMethod === 'POST') {
    if (!rawBody) return jsonResp(400, { error: 'Empty SVG body' });
    svgText = rawBody;
  } else {
    return jsonResp(405, { error: 'Method not allowed' });
  }

  try {
    const { buffer, mimeType } = renderToBuffer(svgText, format);
    return imageResp(buffer, mimeType);
  } catch (resvgErr) {
    const fallback = params.get('fallback_url');
    if (fallback) {
      try {
        const wsrvRes = await fetchFromWsrv(fallback, format);
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