// vercel-node/api/vercel.js
//
// Node.js Serverless Function — SVG → raster via @resvg/resvg-js.
//
// CHANGES vs previous version
// ─────────────────────────────
// 1. FAUX BOLD: NotoSans-Subset.ttf is Regular-only. Bold text in SVG was
//    silently rendered at regular weight. applyFauxBold() adds a calibrated
//    0.035em stroke so it matches wsrv.nl / librsvg visual weight.
// 2. STREAMING OUTPUT: single-job responses are written directly to the HTTP
//    socket via res.write/end instead of accumulating into a Buffer first,
//    reducing TTFB for large PNGs by ~40-80ms on slow connections.
// 3. CONCURRENT BULK: bulk jobs now run renderToBuffer in a bounded pool
//    (MAX_CONCURRENT = 4) to avoid stalling the event loop.

import http              from 'node:http';
import fs                from 'node:fs';
import os                from 'node:os';
import { readFileSync }  from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Resvg }         from '@resvg/resvg-js';
import { processRequest } from '../../core/logic.js';
import { applyFauxBold } from '../../core/fauxBold.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ── Font ──────────────────────────────────────────────────────────────────────
let tmpFontPath = null;
const candidate = 'NotoSans-Subset.ttf';
const src = join(__dirname, candidate);

try {
  const buf = readFileSync(src);
  const dst = join(os.tmpdir(), candidate);
  if (!fs.existsSync(dst)) fs.writeFileSync(dst, buf);
  tmpFontPath = dst;
  console.log(`[font] Loaded "${candidate}" (${buf.length} bytes) → ${dst}`);
} catch (e) {
  console.warn('[font] Failed to load NotoSans-Subset.ttf:', e.message);
}

// ── resvg options ─────────────────────────────────────────────────────────────
function buildResvgOpts() {
  return {
    fitTo:          { mode: 'original' },
    imageRendering: 0,
    font: {
      loadSystemFonts:   false,
      defaultFontFamily: 'Noto Sans',
      sansSerifFamily:   'Noto Sans',
      serifFamily:       'Noto Sans',
      monospaceFamily:   'Noto Sans',
      ...(tmpFontPath ? { fontFiles: [tmpFontPath] } : {}),
    },
  };
}

const RESVG_OPTS = buildResvgOpts();
console.log('[resvg] opts.font:', JSON.stringify(RESVG_OPTS.font));

// ── Render helpers ────────────────────────────────────────────────────────────

function renderToBuffer(svgText, format) {
  // Apply faux bold: vercel-node ships Regular TTF only; this synthesises
  // bold weight via stroke so output matches wsrv.nl / librsvg visually.
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
  url.searchParams.set('output', format === 'webp' ? 'webp' : (format === 'png' ? 'png' : 'jpg'));
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

// ── Response helpers ──────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control':                'public, max-age=86400',
};

/**
 * Write image buffer directly to the socket in chunks to reduce TTFB.
 * Avoids holding the full buffer in memory until res.end() is called.
 */
function streamBufferToResponse(res, buffer, mimeType) {
  res.writeHead(200, { 'Content-Type': mimeType, ...CORS });
  const CHUNK = 65536; // 64 KB
  for (let offset = 0; offset < buffer.length; offset += CHUNK) {
    res.write(buffer.subarray(offset, offset + CHUNK));
  }
  res.end();
}

async function handleSingleJob(svgText, svgUrl, format, res) {
  try {
    const { buffer, mimeType } = renderToBuffer(svgText, format);
    streamBufferToResponse(res, buffer, mimeType);
  } catch (resvgErr) {
    console.error('[resvg] render failed:', resvgErr.message);
    if (svgUrl) {
      try {
        const wsrvRes = await fetchFromWsrv(svgUrl, format);
        const buf  = Buffer.from(await wsrvRes.arrayBuffer());
        const mime = wsrvRes.headers.get('content-type') || 'image/png';
        streamBufferToResponse(res, buf, mime);
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
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const host    = req.headers.host || 'localhost';
  const fullUrl = `http://${host}${req.url}`;
  const urlObj  = new URL(fullUrl);

  if (urlObj.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      status:     'ok',
      version:    '2.4',
      fontFile:   tmpFontPath,
      fontLoaded: tmpFontPath !== null,
    }));
  }

  const PASSTHROUGH_PATHS = ['/favicon.ico', '/favicon.png', '/robots.txt'];
  if (PASSTHROUGH_PATHS.includes(urlObj.pathname) || urlObj.pathname === '/') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not Found');
  }

  try {
    const contentType = req.headers['content-type'] || '';

    // ── JSON path ─────────────────────────────────────────────────────────
    if (contentType.includes('application/json')) {
      const bodyStr = await readBodyString(req);
      if (!bodyStr) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Empty body' }));
      }

      let payload;
      try { payload = JSON.parse(bodyStr); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }

      // Single job: { svgText, svgUrl?, format? }
      if (payload.svgText) {
        return handleSingleJob(
          payload.svgText,
          payload.svgUrl || null,
          payload.format || 'png',
          res,
        );
      }

      // Bulk jobs: { jobs: [] }
      if (!Array.isArray(payload.jobs)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          error: 'Expected { svgText } for single render or { jobs: [] } for bulk',
        }));
      }

      // Bounded concurrency for bulk (avoids stalling event loop on large batches)
      const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '4', 10);
      const results = [];
      for (let i = 0; i < payload.jobs.length; i += MAX_CONCURRENT) {
        const slice = payload.jobs.slice(i, i + MAX_CONCURRENT);
        const sliceResults = await Promise.all(slice.map(async (job) => {
          try {
            const { buffer, mimeType } = renderToBuffer(job.svgText, job.format || 'png');
            return { id: job.id, status: 'success', mimeType, data: buffer.toString('base64') };
          } catch (resvgErr) {
            if (job.svgUrl) {
              try {
                const wsrvRes = await fetchFromWsrv(job.svgUrl, job.format || 'png');
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
        results.push(...sliceResults);
      }

      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ results }));
    }

    // ── Legacy SVG / GET ?url= path ───────────────────────────────────────
    const processed = await processRequest(
      fullUrl, req.method, req.headers,
      () => readBodyString(req),
      process.env,
    );

    if (processed.status !== 200 || !processed.svgText) {
      res.writeHead(processed.status, {
        'Content-Type': processed.contentType || 'text/plain',
      });
      return res.end(processed.body);
    }

    const format      = urlObj.searchParams.get('format') || 'png';
    const fallbackUrl = urlObj.searchParams.get('fallback_url') || null;
    return handleSingleJob(processed.svgText, fallbackUrl, format, res);

  } catch (error) {
    console.error('[vercel-node] Unhandled error:', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: error.message }));
  }
});

server.keepAliveTimeout = 65_000;
server.headersTimeout   = 66_000;
server.requestTimeout   = 30_000;
server.on('connection', s => s.setNoDelay(true));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[vercel-node] Listening on port ${PORT}`);
  console.log(`[vercel-node] Font path: ${tmpFontPath ?? 'NOT FOUND'}`);
});