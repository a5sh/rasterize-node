// vercel-node/api/vercel.js
//
// Node.js Serverless Function — SVG → raster via @resvg/resvg-js.
//
// KEY FIXES vs previous version
// ──────────────────────────────
// 1. FONT: @resvg/resvg-js (native) does NOT support `fontBuffers` — that is a
//    resvg-wasm-only option. Native resvg-js requires `fontFiles` (filesystem paths)
//    or `fontDirs`. We write the TTF buffer to /tmp once at cold start and pass the
//    path via `fontFiles`. Matches the working netlify handler pattern exactly.
//
// 2. INVALID URL: core/logic.js does `new URL(reqUrl)` which throws when passed a
//    bare path like "/" or "/favicon.ico". Pass a full absolute URL constructed from
//    req.headers.host. Also short-circuit non-rasterizer paths before reaching
//    processRequest.
//
// REQUEST SHAPES (from rasterBalancer)
// ─────────────────────────────────────
// Single:  POST application/json  { svgText, svgUrl?, format? }
// Bulk:    POST application/json  { jobs: [{ id, svgText, svgUrl?, format? }] }

import http              from 'node:http';
import fs                from 'node:fs';
import os                from 'node:os';
import { readFileSync }  from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Resvg }         from '@resvg/resvg-js';
import { processRequest } from '../../core/logic.js';

// ── ESM __dirname shim ────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ── Font: read TTF from api/ dir, write to /tmp, keep path for resvg-js ───────
//
// @resvg/resvg-js (native N-API) resolves fonts from the filesystem only.
// `fontBuffers` is a resvg-wasm option and is silently ignored here.
// Writing to /tmp once at cold start is the correct pattern (same as netlify).

// Replace the FONT_CANDIDATES loop block with this statically analyzable path:
let tmpFontPath = null;
const candidate = 'NotoSans-Subset.ttf';
const src = join(__dirname, candidate);

try {
  const buf = readFileSync(src);
  const dst = join(os.tmpdir(), candidate);
  if (!fs.existsSync(dst)) {
    fs.writeFileSync(dst, buf);
  }
  tmpFontPath = dst;
  console.log(`[font] Loaded "${candidate}" (${buf.length} bytes) → ${dst}`);
} catch (e) {
  console.warn('[font] Failed to load NotoSans-Subset.ttf:', e.message);
}

if (!tmpFontPath) {
  console.warn(
    '[font] No font file found in vercel-node/api/ — text will be invisible.\n' +
    '       Commit one of: ' + FONT_CANDIDATES.join(', '),
  );
}

// ── resvg options ─────────────────────────────────────────────────────────────
// fontFiles (not fontBuffers) is the correct key for @resvg/resvg-js native.
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

// Build once; resvg-js reads font files at Resvg() construction time
const RESVG_OPTS = buildResvgOpts();
console.log('[resvg] opts.font:', JSON.stringify(RESVG_OPTS.font));

// ── Render helpers ────────────────────────────────────────────────────────────

function renderToBuffer(svgText, format) {
  const resvg    = new Resvg(svgText, RESVG_OPTS);
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

async function handleSingleJob(svgText, svgUrl, format, res) {
  try {
    const { buffer, mimeType } = renderToBuffer(svgText, format);
    res.writeHead(200, {
      'Content-Type':                mimeType,
      'Cache-Control':               'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(buffer);
  } catch (resvgErr) {
    console.error('[resvg] render failed:', resvgErr.message);
    if (svgUrl) {
      try {
        const wsrvRes = await fetchFromWsrv(svgUrl, format);
        const buf  = Buffer.from(await wsrvRes.arrayBuffer());
        const mime = wsrvRes.headers.get('content-type') || 'image/png';
        res.writeHead(200, {
          'Content-Type':                mime,
          'Cache-Control':               'public, max-age=86400',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(buf);
        return;
      } catch (wsrvErr) {
        res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: `resvg: ${resvgErr.message} | wsrv: ${wsrvErr.message}` }));
        return;
      }
    }
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
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

  // Build a full absolute URL — required by core/logic.js new URL(reqUrl)
  const host    = req.headers.host || 'localhost';
  const fullUrl = `http://${host}${req.url}`;
  const urlObj  = new URL(fullUrl);

  // ── Health ────────────────────────────────────────────────────────────────
  if (urlObj.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      status:     'ok',
      version:    '2.3',
      fontFile:   tmpFontPath,
      fontLoaded: tmpFontPath !== null,
    }));
  }

  // ── Short-circuit noise paths that would crash core/logic.js ─────────────
  // Vercel health probes, browser favicon requests, root path pings.
  // Return a clean 404 rather than letting them fall into processRequest.
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

      const results = await Promise.all(payload.jobs.map(async (job) => {
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
              return {
                id:     job.id,
                status: 'error',
                error:  `resvg: ${resvgErr.message} | wsrv: ${wsrvErr.message}`,
              };
            }
          }
          return { id: job.id, status: 'error', error: resvgErr.message };
        }
      }));

      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ results }));
    }

    // ── Legacy SVG / GET ?url= path ───────────────────────────────────────
    // Pass the full absolute URL so core/logic.js new URL() doesn't throw.
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[vercel-node] Listening on port ${PORT}`);
  console.log(`[vercel-node] Font path: ${tmpFontPath ?? 'NOT FOUND'}`);
});