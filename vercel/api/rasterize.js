// vercel/api/rasterize.js
//
// v7 — Gzip decompression + icon placeholder expansion + bandwidth optimisations
// ─────────────────────────────────────────────────────────────────────────────
// KEY CHANGES
//   • X-SVG-Encoding: gzip  → decompress body with node:zlib gunzipSync before
//     handing SVG to the render pipeline.  The balancer sends compressed POSTs
//     to non-URL-payload nodes; USW receives GET ?url= instead (no decompression
//     needed there — the node just fetches the SVG from the CF edge cache).
//   • expandIconPlaceholder() — replaces <!--ICONS:key1,key2--> with real
//     <symbol> elements fetched once from api.spicydevs.xyz/data/icons and
//     cached in module memory for the lifetime of the Lambda container.
//   • warmIconCache() at module load so icons are ready before first request.
//   • X-Node: 'vercel-usw' for attribution + diagnostics.

import { gunzipSync }                            from 'node:zlib';
import { Resvg }                                 from '@resvg/resvg-js';
import { applyFauxBold }                         from '../lib/fauxBold.js';
import { buildResvgOpts }                        from '../lib/sharedRender.js';
import {
  expandIconPlaceholder,
  warmIconCache,
  iconCacheStatus,
}                                                from '../lib/iconCache.js';

const RESVG_OPTS = buildResvgOpts();

// Warm icon cache on cold start (fire-and-forget).
warmIconCache();

// ── Vercel function config ────────────────────────────────────────────────────
export const config = { maxDuration: 10 };

// ── CORS ──────────────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Format, X-SVG-Encoding',
};

// ── Decompression ─────────────────────────────────────────────────────────────

/**
 * Decompress a Buffer if X-SVG-Encoding: gzip is set.
 * Uses node:zlib for synchronous decompression — safe in Lambda context.
 */
function decompressBody(buf, encoding) {
  if (encoding === 'gzip') {
    try { return gunzipSync(buf).toString('utf8'); } catch { /* fall through */ }
  }
  return buf.toString('utf8');
}

// ── External image embedding ──────────────────────────────────────────────────

async function embedExternalImages(svgText) {
  const matches = [...svgText.matchAll(/href="(https?:\/\/[^"]+)"/g)];
  if (!matches.length) return svgText;
  const unique = [...new Set(matches.map(m => m[1]))];
  const reps   = await Promise.all(unique.map(async url => {
    try {
      const res = await fetch(url, {
        signal:  AbortSignal.timeout(8_000),
        headers: { 'User-Agent': 'SpicyDevs-Rasterizer/7.0' },
      });
      if (!res.ok) return { url, dataUri: null };
      const buf = Buffer.from(await res.arrayBuffer());
      const ct  = res.headers.get('content-type') || 'image/jpeg';
      return { url, dataUri: `data:${ct};base64,${buf.toString('base64')}` };
    } catch { return { url, dataUri: null }; }
  }));
  for (const { url, dataUri } of reps)
    if (dataUri) svgText = svgText.split(`href="${url}"`).join(`href="${dataUri}"`);
  return svgText;
}

// ── Render pipeline ───────────────────────────────────────────────────────────

async function renderToBuffer(svgText, format) {
  // 1. Expand icon placeholder from module-level icon cache
  const withIcons  = await expandIconPlaceholder(svgText);
  // 2. Embed proxied poster URLs as base64 so resvg can render them
  const embedded   = await embedExternalImages(withIcons);
  // 3. Synthesise faux-bold
  const processed  = applyFauxBold(embedded);
  // 4. Render
  const resvg      = new Resvg(processed, RESVG_OPTS);
  const rendered   = resvg.render();

  if ((format === 'jpg' || format === 'jpeg') && typeof rendered.asJpeg === 'function')
    return { buffer: rendered.asJpeg(85), mimeType: 'image/jpeg' };
  if (format === 'webp' && typeof rendered.asWebp === 'function')
    return { buffer: rendered.asWebp(85), mimeType: 'image/webp' };
  return { buffer: rendered.asPng(), mimeType: 'image/png' };
}

// ── Body reader ───────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c  => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Response helpers ──────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
}

function sendImage(res, buffer, mimeType) {
  res.writeHead(200, {
    'Content-Type':   mimeType,
    'Cache-Control':  'public, max-age=86400',
    'X-Node':         'vercel-usw',
    ...CORS,
  });
  res.end(Buffer.from(buffer));
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url    = new URL(req.url, `https://${req.headers.host || 'vercel.app'}`);
  const format = (
    req.headers['x-format'] ||
    url.searchParams.get('format') ||
    'png'
  ).toLowerCase();

  // ── Health check ──────────────────────────────────────────────────────────
  if (url.pathname === '/health') {
    return sendJson(res, 200, {
      status:    'ok',
      version:   '7.0',
      node:      'vercel-usw',
      fontReady: !!(RESVG_OPTS.font?.fontFiles?.length),
      iconCache: iconCacheStatus(),
    });
  }

  // ── GET ?url= (URL-payload path — balancer sends this for USW) ────────────
  if (req.method === 'GET') {
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) return sendJson(res, 400, { error: 'Missing ?url= parameter' });
    try {
      const r = await fetch(targetUrl, {
        signal:  AbortSignal.timeout(8_000),
        headers: { 'User-Agent': 'SpicyDevs-Rasterizer/7.0' },
      });
      if (!r.ok) return sendJson(res, 502, { error: `SVG fetch failed: ${r.status}` });
      const svgText = await r.text();
      const { buffer, mimeType } = await renderToBuffer(svgText, format);
      return sendImage(res, buffer, mimeType);
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
  }

  // ── POST (compressed or plain SVG body) ───────────────────────────────────
  if (req.method === 'POST') {
    const ct       = req.headers['content-type'] || '';
    const encoding = req.headers['x-svg-encoding'] || '';
    const bodyBuf  = await readBody(req);

    // ── JSON body (single or bulk) ────────────────────────────────────────
    if (ct.includes('application/json')) {
      if (!bodyBuf.length) return sendJson(res, 400, { error: 'Empty body' });

      let payload;
      try   { payload = JSON.parse(bodyBuf); }
      catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }

      if (payload.svgText) {
        const fmt = payload.format || format;
        try {
          const { buffer, mimeType } = await renderToBuffer(payload.svgText, fmt);
          return sendImage(res, buffer, mimeType);
        } catch (e) {
          return sendJson(res, 500, { error: e.message });
        }
      }

      if (Array.isArray(payload.jobs)) {
        const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '4', 10);
        const results = [];
        for (let i = 0; i < payload.jobs.length; i += MAX_CONCURRENT) {
          const slice = payload.jobs.slice(i, i + MAX_CONCURRENT);
          const batch = await Promise.all(slice.map(async job => {
            const fmt = job.format || 'png';
            try {
              const { buffer, mimeType } = await renderToBuffer(job.svgText, fmt);
              return { id: job.id, status: 'success', mimeType, data: Buffer.from(buffer).toString('base64') };
            } catch (e) {
              return { id: job.id, status: 'error', error: e.message };
            }
          }));
          results.push(...batch);
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS });
        return res.end(JSON.stringify({ results }));
      }

      return sendJson(res, 400, { error: 'Expected { svgText } or { jobs: [] }' });
    }

    // ── Raw SVG body (may be gzip-compressed) ─────────────────────────────
    if (!bodyBuf.length) return sendJson(res, 400, { error: 'Empty SVG body' });

    const svgText = decompressBody(bodyBuf, encoding);
    try {
      const { buffer, mimeType } = await renderToBuffer(svgText, format);
      return sendImage(res, buffer, mimeType);
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  return sendJson(res, 405, { error: 'Method not allowed' });
}