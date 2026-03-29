// vercel-node/api/vercel.js
//
// Node.js Serverless Function — SVG → raster via @resvg/resvg-js.
//
// FONT LOADING STRATEGY
// ─────────────────────
// resvg-js needs explicit font buffers when loadSystemFonts=false.
// Vercel bundles every file co-located with the function (same /api dir),
// so we read the TTF directly with fs.readFileSync at module-init time
// (cold start), not per-request. This eliminates the missing font-data.js
// import that caused the ERR_MODULE_NOT_FOUND crash.
//
// The font file must be committed at: vercel-node/api/notosans-subset.ttf
// If the file is absent the handler degrades to no-font (text invisible)
// and logs a warning — it does NOT crash.

import http           from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Resvg }       from '@resvg/resvg-js';
import { processRequest } from '../../core/logic.js';

// ── ESM __dirname shim ────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ── Font loading (cold-start, once per isolate) ───────────────────────────────
//
// Try several candidate filenames in order so the handler works regardless
// of whether the font was committed as .ttf, .otf, or without an extension.
const FONT_CANDIDATES = [
  'notosans-subset.ttf',
  'notosans-subset.otf',
  'notosans-subset',
  'NotoSans-subset.ttf',
  'NotoSans-subset.otf',
];

let fontBuffers = [];

for (const candidate of FONT_CANDIDATES) {
  try {
    const buf = readFileSync(join(__dirname, candidate));
    fontBuffers = [buf];
    console.log(`[font] Loaded "${candidate}" (${buf.length} bytes)`);
    break;
  } catch {
    // Not found — try next candidate
  }
}

if (fontBuffers.length === 0) {
  console.warn(
    '[font] No font file found in /api — text will be invisible in rasterized output.\n' +
    '       Commit one of these to vercel-node/api/: ' + FONT_CANDIDATES.join(', '),
  );
}

// ── resvg options ─────────────────────────────────────────────────────────────
const RESVG_OPTS = {
  fitTo:          { mode: 'original' },
  font: {
    loadSystemFonts: false,   // Vercel Lambda has no usable system fonts
    fontBuffers,              // [] degrades gracefully (invisible text, no crash)
  },
  imageRendering: 0,          // 0 = optimizeQuality (same as render-node)
};

// ── Format → MIME ─────────────────────────────────────────────────────────────
const MIME = {
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

// ── Render SVG buffer ─────────────────────────────────────────────────────────
function renderToBuffer(svgText, format) {
  const resvg    = new Resvg(svgText, RESVG_OPTS);
  const rendered = resvg.render();

  if ((format === 'jpg' || format === 'jpeg') && typeof rendered.asJpeg === 'function') {
    return { buffer: rendered.asJpeg(85), mimeType: MIME.jpg };
  }
  if (format === 'webp' && typeof rendered.asWebp === 'function') {
    return { buffer: rendered.asWebp(85), mimeType: MIME.webp };
  }
  return { buffer: rendered.asPng(), mimeType: MIME.png };
}

// ── wsrv.nl fallback ──────────────────────────────────────────────────────────
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

// ── Request body reader ───────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end',  () => resolve(body));
  });
}

// ── HTTP server (used by Vercel Node.js serverless runtime) ───────────────────
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

  try {
    const reqUrl     = `http://${req.headers.host}${req.url}`;
    const urlObj     = new URL(reqUrl);
    const getBodyText = () => readBody(req);

    // ── Bulk path (JSON body with jobs array) ─────────────────────────────
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('application/json')) {
      const bodyStr = await getBodyText();
      let payload;
      try {
        payload = JSON.parse(bodyStr);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }

      if (!Array.isArray(payload.jobs)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: "Expected JSON object with a 'jobs' array" }));
      }

      const results = await Promise.all(payload.jobs.map(async (job) => {
        try {
          const { buffer, mimeType } = renderToBuffer(job.svgText, job.format || 'png');
          return {
            id:       job.id,
            status:   'success',
            mimeType,
            data:     buffer.toString('base64'),
          };
        } catch (resvgErr) {
          // Attempt wsrv fallback if a source URL was provided
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

    // ── Single path ───────────────────────────────────────────────────────
    const processed = await processRequest(
      reqUrl, req.method, req.headers, getBodyText, process.env,
    );

    if (processed.status !== 200 || !processed.svgText) {
      res.writeHead(processed.status, {
        'Content-Type': processed.contentType || 'text/plain',
      });
      return res.end(processed.body);
    }

    const format      = urlObj.searchParams.get('format') || 'png';
    const fallbackUrl = urlObj.searchParams.get('fallback_url') || null;

    try {
      const { buffer, mimeType } = renderToBuffer(processed.svgText, format);
      res.writeHead(200, {
        'Content-Type':  mimeType,
        'Cache-Control': 'public, max-age=86400',
      });
      return res.end(buffer);
    } catch (resvgErr) {
      if (fallbackUrl) {
        try {
          const wsrvRes = await fetchFromWsrv(fallbackUrl, format);
          const buf  = Buffer.from(await wsrvRes.arrayBuffer());
          const mime = wsrvRes.headers.get('content-type') || 'image/png';
          res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
          return res.end(buf);
        } catch (wsrvErr) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            error: `resvg: ${resvgErr.message} | wsrv: ${wsrvErr.message}`,
          }));
        }
      }
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: resvgErr.message }));
    }

  } catch (error) {
    console.error('[vercel-node] Unhandled error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[vercel-node] Listening on port ${PORT}`);
  console.log(`[vercel-node] Font buffers loaded: ${fontBuffers.length}`);
});