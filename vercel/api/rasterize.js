// vercel/api/rasterize.js
//
// FIXED v5 — Proper Vercel serverless handler.
// The previous version called http.createServer() which Vercel's runtime
// never invokes — it expects an exported default async function.
//
// Handler contract:
//   export default async function handler(req, res)
//   req = Node.js IncomingMessage  (has .method, .url, .headers)
//   res = Node.js ServerResponse   (writeHead / end)
//
// Accepts the same wire protocol as every other node in the fleet:
//   POST /             raw SVG body  (Content-Type: image/svg+xml)
//   POST /             JSON body     (Content-Type: application/json)
//   GET  /?url=<url>   fetch+render
//   GET  /health

import { Resvg }         from '@resvg/resvg-js';
import { applyFauxBold } from '../lib/fauxBold.js';
import { buildResvgOpts } from '../lib/sharedRender.js';

const RESVG_OPTS = buildResvgOpts();

// ── Vercel function config ────────────────────────────────────────────────────
export const config = { maxDuration: 10 };

// ── CORS headers ──────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Format',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function embedExternalImages(svgText) {
  const matches = [...svgText.matchAll(/href="(https?:\/\/[^"]+)"/g)];
  if (!matches.length) return svgText;
  const unique = [...new Set(matches.map(m => m[1]))];
  const reps   = await Promise.all(unique.map(async url => {
    try {
      const res = await fetch(url, {
        signal:  AbortSignal.timeout(6000),
        headers: { 'User-Agent': 'SpicyDevs-Rasterizer/5.0' },
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

async function renderToBuffer(svgText, format) {
  const embedded  = await embedExternalImages(svgText);
  const processed = applyFauxBold(embedded);
  const resvg     = new Resvg(processed, RESVG_OPTS);
  const rendered  = resvg.render();
  if ((format === 'jpg' || format === 'jpeg') && typeof rendered.asJpeg === 'function')
    return { buffer: rendered.asJpeg(85), mimeType: 'image/jpeg' };
  if (format === 'webp' && typeof rendered.asWebp === 'function')
    return { buffer: rendered.asWebp(85), mimeType: 'image/webp' };
  return { buffer: rendered.asPng(), mimeType: 'image/png' };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c  => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(payload);
}

function sendImage(res, buffer, mimeType) {
  res.writeHead(200, {
    'Content-Type':   mimeType,
    'Cache-Control':  'public, max-age=86400',
    'X-Node':         'vercel',
    ...CORS,
  });
  res.end(Buffer.from(buffer));
}

// ── Main handler (exported — Vercel calls this) ───────────────────────────────

export default async function handler(req, res) {
  // CORS headers on every response
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url    = new URL(req.url, `https://${req.headers.host || 'vercel.app'}`);
  const format = (
    req.headers['x-format'] ||
    url.searchParams.get('format') ||
    'png'
  ).toLowerCase();

  // Health check
  if (url.pathname === '/health') {
    return sendJson(res, 200, {
      status:    'ok',
      version:   '5.0',
      node:      'vercel',
      fontReady: !!(RESVG_OPTS.font?.fontFiles?.length),
    });
  }

  // ── POST ────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const ct      = req.headers['content-type'] || '';
    const bodyBuf = await readBody(req);

    // JSON body
    if (ct.includes('application/json')) {
      if (!bodyBuf.length) return sendJson(res, 400, { error: 'Empty body' });

      let payload;
      try   { payload = JSON.parse(bodyBuf); }
      catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }

      // Single job
      if (payload.svgText) {
        const fmt = payload.format || format;
        try {
          const { buffer, mimeType } = await renderToBuffer(payload.svgText, fmt);
          return sendImage(res, buffer, mimeType);
        } catch (e) {
          return sendJson(res, 500, { error: e.message });
        }
      }

      // Bulk jobs
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

      return sendJson(res, 400, { error: "Expected { svgText } or { jobs: [] }" });
    }

    // Raw SVG body
    if (!bodyBuf.length) return sendJson(res, 400, { error: 'Empty SVG body' });
    const svgText = bodyBuf.toString('utf8');
    try {
      const { buffer, mimeType } = await renderToBuffer(svgText, format);
      return sendImage(res, buffer, mimeType);
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // ── GET ─────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) return sendJson(res, 400, { error: 'Missing ?url= parameter' });
    try {
      const r = await fetch(targetUrl, {
        signal:  AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'SpicyDevs-Rasterizer/5.0' },
      });
      if (!r.ok) return sendJson(res, 502, { error: `SVG fetch failed: ${r.status}` });
      const svgText = await r.text();
      const { buffer, mimeType } = await renderToBuffer(svgText, format);
      return sendImage(res, buffer, mimeType);
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
  }

  return sendJson(res, 405, { error: 'Method not allowed' });
}