// vercel/api/rasterize.js
//
// Vercel Serverless Function — SVG → raster via @resvg/resvg-js.
//
// lib/ is populated by vercelBuild (see package.json / vercel.json) which runs:
//   node ../../scripts/build.mjs vercel
//
// FONT + BOLD STRATEGY (same on every platform)
// ──────────────────────────────────────────────
// • NotoSans-Subset.ttf (Regular only) via sharedRender.buildResvgOpts().
// • applyFauxBold() synthesises bold via 0.035em stroke — matches wsrv.nl.

import http              from 'node:http';
import { Resvg }         from '@resvg/resvg-js';
import { applyFauxBold }  from '../lib/fauxBold.js';
import { buildResvgOpts } from '../lib/sharedRender.js';

const RESVG_OPTS = buildResvgOpts();

// ── Render helpers ────────────────────────────────────────────────────────────

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
    const res = await fetch(u.toString(), { signal: ac.signal, headers: { 'User-Agent': 'SpicyDevs-Rasterizer/3.0' } });
    if (!res.ok) throw new Error(`wsrv.nl returned ${res.status}`);
    return res;
  } finally { clearTimeout(t); }
}

// ── Response helpers ──────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control':                'public, max-age=86400',
};

function streamBuffer(res, buffer, mimeType) {
  res.writeHead(200, { 'Content-Type': mimeType, ...CORS });
  const CHUNK = 65536;
  for (let i = 0; i < buffer.length; i += CHUNK) {
    res.write(buffer.subarray(i, i + CHUNK));
  }
  res.end();
}

async function handleSingleJob(svgText, svgUrl, format, res) {
  try {
    const { buffer, mimeType } = renderToBuffer(svgText, format);
    streamBuffer(res, buffer, mimeType);
  } catch (resvgErr) {
    if (svgUrl) {
      try {
        const wsrvRes = await fetchFromWsrv(svgUrl, format);
        const buf  = Buffer.from(await wsrvRes.arrayBuffer());
        const mime = wsrvRes.headers.get('content-type') || 'image/png';
        streamBuffer(res, buf, mime);
        return;
      } catch (wsrvErr) {
        res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: `resvg: ${resvgErr.message} | wsrv: ${wsrvErr.message}` }));
        return;
      }
    }
    res.writeHead(500, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: resvgErr.message }));
  }
}

function readBodyString(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data',  c => chunks.push(c));
    req.on('end',   () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  const host   = req.headers.host || 'localhost';
  const urlObj = new URL(`http://${host}${req.url}`);

  if (urlObj.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ status: 'ok', version: '3.0', node: 'vercel', fontReady: RESVG_OPTS.font?.fontFiles?.length > 0 }));
  }

  try {
    const ct = req.headers['content-type'] || '';

    // ── JSON path ───────────────────────────────────────────────────────────
    if (ct.includes('application/json')) {
      const bodyStr = await readBodyString(req);
      if (!bodyStr) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Empty body' })); }

      let payload;
      try { payload = JSON.parse(bodyStr); }
      catch { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }

      // Single
      if (payload.svgText) {
        return handleSingleJob(payload.svgText, payload.svgUrl || null, payload.format || 'png', res);
      }

      // Bulk
      if (!Array.isArray(payload.jobs)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Expected { svgText } or { jobs: [] }' }));
      }

      const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '4', 10);
      const results = [];
      for (let i = 0; i < payload.jobs.length; i += MAX_CONCURRENT) {
        const slice = payload.jobs.slice(i, i + MAX_CONCURRENT);
        const batch = await Promise.all(slice.map(async job => {
          const fmt = job.format || 'png';
          try {
            const { buffer, mimeType } = renderToBuffer(job.svgText, fmt);
            return { id: job.id, status: 'success', mimeType, data: buffer.toString('base64') };
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
        results.push(...batch);
      }

      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ results }));
    }

    // ── Legacy SVG path ─────────────────────────────────────────────────────
    const format      = urlObj.searchParams.get('format') || 'png';
    const fallbackUrl = urlObj.searchParams.get('fallback_url') || null;

    let svgText;
    if (req.method === 'GET') {
      const targetUrl = urlObj.searchParams.get('url');
      if (!targetUrl) { res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('Missing ?url= parameter'); }
      const r = await fetch(targetUrl, { headers: { 'User-Agent': 'SpicyDevs-Rasterizer/3.0' }, signal: AbortSignal.timeout(8_000) });
      if (!r.ok) { res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: `SVG fetch failed: ${r.status}` })); }
      svgText = await r.text();
    } else if (req.method === 'POST') {
      svgText = await readBodyString(req);
      if (!svgText) { res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('Empty SVG body'); }
    } else {
      res.writeHead(405, { 'Content-Type': 'text/plain' }); return res.end('Method not allowed');
    }

    return handleSingleJob(svgText, fallbackUrl, format, res);

  } catch (error) {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
});

server.keepAliveTimeout = 65_000;
server.headersTimeout   = 66_000;
server.requestTimeout   = 30_000;
server.on('connection', s => s.setNoDelay(true));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[vercel-node] Listening on :${PORT}`);
  console.log(`[vercel-node] Font: ${RESVG_OPTS.font?.fontFiles?.[0] ?? 'NOT FOUND'}`);
});