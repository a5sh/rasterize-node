// vercel-node/api/vercel.js
//
// Node.js Serverless Function — SVG → raster via @resvg/resvg-js.
//
// REQUEST SHAPES HANDLED
// ──────────────────────
// rasterBalancer.fetchNode() sends:
//   POST /api/vercel
//   Content-Type: application/json
//   Body: { svgUrl, svgText, format }          ← single job
//
// rasterBalancer.dispatchBulkRasterization() sends:
//   POST /api/vercel
//   Content-Type: application/json
//   Body: { jobs: [{ id, svgText, svgUrl, format }, …] }  ← bulk
//
// Both arrive as application/json. The previous version only handled the
// bulk shape and returned 400 for every single-job request.
//
// FONT LOADING
// ────────────
// fs.readFileSync at module-init (cold start), not per-request.
// Font file must be committed at: vercel-node/api/notosans-subset.ttf
// Degrades to invisible text (not crash) when absent.

import http               from 'node:http';
import { readFileSync }   from 'node:fs';
import { fileURLToPath }  from 'node:url';
import { dirname, join }  from 'node:path';
import { Resvg }          from '@resvg/resvg-js';
import { processRequest } from '../../core/logic.js';

// ── ESM __dirname shim ────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ── Font loading (cold-start, once per isolate) ───────────────────────────────
const FONT_CANDIDATES = [
  'notosans-subset.ttf',
  'NotoSans-Subset.ttf',
  'NotoSans-subset.ttf',
  'notosans-subset.otf',
  'notosans-subset',
];

let fontBuffers = [];

for (const candidate of FONT_CANDIDATES) {
  try {
    const buf = readFileSync(join(__dirname, candidate));
    fontBuffers = [buf];
    console.log(`[font] Loaded "${candidate}" (${buf.length} bytes)`);
    break;
  } catch {
    // try next
  }
}

if (fontBuffers.length === 0) {
  console.warn(
    '[font] No font file found in vercel-node/api/ — text will be invisible.\n' +
    '       Commit one of: ' + FONT_CANDIDATES.join(', '),
  );
}

// ── resvg options ─────────────────────────────────────────────────────────────
const RESVG_OPTS = {
  fitTo:          { mode: 'original' },
  font: {
    loadSystemFonts:   false,
    fontBuffers,
    defaultFontFamily: 'Noto Sans',
    sansSerifFamily:   'Noto Sans',
  },
  imageRendering: 0,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// Render a single { svgText, svgUrl, format } job and write to res.
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

  const urlObj = new URL(req.url, `http://${req.headers.host}`);

  if (urlObj.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      status:      'ok',
      version:     '2.2',
      fontsLoaded: fontBuffers.length,
      fontFamily:  fontBuffers.length ? 'Noto Sans' : null,
    }));
  }

  try {
    const contentType = req.headers['content-type'] || '';

    // ── JSON path: single job OR bulk ─────────────────────────────────────
    if (contentType.includes('application/json')) {
      const bodyStr = await readBodyString(req);
      if (!bodyStr) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Empty body' }));
      }

      let payload;
      try {
        payload = JSON.parse(bodyStr);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }

      // ── Single job ────────────────────────────────────────────────────
      // Shape sent by rasterBalancer.fetchNode(): { svgText, svgUrl, format }
      if (payload.svgText) {
        return handleSingleJob(
          payload.svgText,
          payload.svgUrl || null,
          payload.format || 'png',
          res,
        );
      }

      // ── Bulk jobs ─────────────────────────────────────────────────────
      // Shape sent by rasterBalancer.dispatchBulkRasterization(): { jobs: [] }
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
              const buf     = Buffer.from(await wsrvRes.arrayBuffer());
              const mime    = wsrvRes.headers.get('content-type') || 'image/png';
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

    // ── Legacy SVG / GET path ─────────────────────────────────────────────
    const processed = await processRequest(
      req.url, req.method, req.headers,
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
  console.log(`[vercel-node] Font buffers: ${fontBuffers.length} (${fontBuffers[0]?.length ?? 0} bytes)`);
});