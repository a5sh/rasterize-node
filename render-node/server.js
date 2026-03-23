// render-node/server.js  (apply identical changes to node/index.js)
//
// Performance changes vs previous version:
//
//   1. WORKER THREAD POOL (biggest win)
//      new Resvg().render() is synchronous + CPU-bound.  Running it on the
//      main thread froze the event loop for 200–800 ms per render — no other
//      request could even be *read* during that time.  RenderPool offloads
//      every render to a dedicated worker thread; the main thread stays free
//      for I/O (body reads, health checks, wsrv fallbacks, Discord webhooks).
//      Pool size = MAX_CONCURRENT (default: cpu core count).
//
//   2. BUFFER BODY READING (O(n) instead of O(n²))
//      Previous: body += chunk.toString()  — each concatenation allocates a
//      new string and copies all previous bytes.  For a 150 KB SVG body with
//      ~20 chunks that's ~1.5 MB of unnecessary copying.
//      Now: push Buffer chunks into an array, Buffer.concat() once at the end.
//
//   3. ZERO-COPY BUFFER TRANSFER
//      Workers transfer their output ArrayBuffer (postMessage transferables)
//      to the main thread instead of copying it.  The main thread wraps it
//      with Buffer.from() (view, no copy) and writes directly to the socket.
//
//   4. HTTP SOCKET TUNING
//      - setNoDelay(true): disable Nagle's algorithm → every write flushes
//        immediately, cutting the 40 ms ACK delay on small responses.
//      - keepAliveTimeout 65 s: longer than the CF Workers / proxy keepalive
//        (60 s default) so the connection stays warm for repeated requests
//        from the same Cloudflare PoP.
//      - headersTimeout 66 s: must exceed keepAliveTimeout.
//
//   5. JIT PRE-WARM (in renderWorker.js)
//      Each worker renders one poster-shaped SVG at spawn time so V8 has
//      already JIT-compiled the hot Resvg paths before the first real request.

import http from 'node:http';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { RenderPool } from '../core/renderPool.js';
import {
  stats,
  logError,
  notifyOnline,
  notifyOffline,
  recordRequest,
  recordJobDuration,
  recordResvgFail,
  recordWsrvFallback,
} from './discord.js';

const PORT           = process.env.PORT || 3000;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || String(os.cpus().length), 10);

// ── Font resolution ───────────────────────────────────────────────────────────

const SYSTEM_FONT_DIRS = [
  '/usr/share/fonts/truetype/liberation2',
  '/usr/share/fonts/truetype/liberation',
  '/usr/share/fonts/truetype/noto',
  '/usr/share/fonts/opentype/noto',
  '/usr/share/fonts/truetype',
  '/usr/share/fonts',
  '/usr/local/share/fonts',
  '/usr/share/fonts/noto',
  '/Library/Fonts',
  '/System/Library/Fonts',
];

function existsDir(d) {
  try { return fs.statSync(d).isDirectory(); } catch { return false; }
}

async function resolveFont() {
  if (process.env.FONT_DIR) {
    const dirs = process.env.FONT_DIR.split(':').filter(existsDir);
    if (dirs.length) { console.log('[font] FONT_DIR:', dirs); return { fontDirs: dirs }; }
  }

  const dirs = SYSTEM_FONT_DIRS.filter(existsDir);
  if (dirs.length) { console.log('[font] System dirs:', dirs); return { fontDirs: dirs }; }

  console.warn('[font] No system font dirs — downloading NotoSans fallback…');
  const fontPath = path.join(os.tmpdir(), 'NotoSans-Regular.ttf');

  if (!fs.existsSync(fontPath)) {
    const FONT_URL =
      'https://github.com/notofonts/notofonts.github.io/raw/main/fonts/NotoSans/hinted/ttf/NotoSans-Regular.ttf';
    try {
      const res = await fetch(FONT_URL, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(fontPath, Buffer.from(await res.arrayBuffer()));
      console.log(`[font] Downloaded fallback (${(fs.statSync(fontPath).size / 1024).toFixed(0)} KB)`);
    } catch (e) {
      console.error('[font] Fallback download failed:', e.message);
      return { fontFiles: [] };
    }
  } else {
    console.log('[font] Reusing cached fallback at', fontPath);
  }
  return { fontFiles: [fontPath] };
}

async function buildResvgOpts() {
  const result       = await resolveFont();
  const isLiberation = result.fontDirs?.some(d => d.includes('liberation'));
  const defaultFamily = isLiberation ? 'Liberation Sans' : 'Noto Sans';

  return {
    fitTo:          { mode: 'original' },
    imageRendering: 0,
    font: {
      loadSystemFonts:   false,
      ...result,
      defaultFontFamily: defaultFamily,
      sansSerifFamily:   defaultFamily,
      serifFamily:       isLiberation ? 'Liberation Serif' : defaultFamily,
      monospaceFamily:   isLiberation ? 'Liberation Mono'  : defaultFamily,
    },
  };
}

// ── Body reader ───────────────────────────────────────────────────────────────
//
// Collects incoming chunks as Buffers and concatenates once at the end.
// Previous string-concat approach (body += chunk.toString()) was O(n²) in
// total bytes — each concat allocates a new string and copies all prior data.
// Buffer.concat is a single native memcpy.

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data',  c => chunks.push(c));
    req.on('end',   () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
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
    clearTimeout(t);
    if (!res.ok) throw new Error(`wsrv.nl returned ${res.status}`);
    return res;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

// ── Stats sync ────────────────────────────────────────────────────────────────
//
// Previously read from module-level counters; now reads from the pool so the
// Discord dashboard reflects the actual worker state.

let pool = null;

function syncStats() {
  if (!pool) return;
  stats.activeJobs = pool.activeJobs;
  stats.queuedJobs = pool.queuedJobs;
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // Cheap URL parse — skip full URL construction for the hot path
  const qIdx    = req.url.indexOf('?');
  const pathname = qIdx === -1 ? req.url : req.url.slice(0, qIdx);
  const search   = qIdx === -1 ? ''      : req.url.slice(qIdx);

  // ── Health check ───────────────────────────────────────────────────────────
  if (pathname === '/health') {
    syncStats();
    const fontCfg = pool?._resvgOpts?.font ?? null;
    res.writeHead(200, {
      'Content-Type':                'application/json',
      'Cache-Control':               'no-store, no-cache, must-revalidate',
      'Pragma':                      'no-cache',
      'Expires':                     '0',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(JSON.stringify({
      status:        'ok',
      version:       '2.1',
      ts:            Date.now(),
      activeJobs:    stats.activeJobs,
      queuedJobs:    stats.queuedJobs,
      workerCount:   pool?.workerCount ?? 0,
      maxConcurrent: MAX_CONCURRENT,
      uptime:        Math.floor(process.uptime()),
      fontsReady:    pool !== null,
      fontDefault:   fontCfg?.defaultFontFamily ?? null,
      fontDirs:      fontCfg?.fontDirs  ?? [],
      fontFiles:     fontCfg?.fontFiles ?? [],
    }));
  }

  // Pool not yet ready (first ~100 ms after boot while font resolution runs)
  if (!pool) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Initialising — retry in a moment.' }));
  }

  try {
    recordRequest();

    // ── Parse query string once ──────────────────────────────────────────────
    const params      = new URLSearchParams(search);
    const format      = params.get('format') || 'png';
    const fallbackUrl = params.get('fallback_url') || null;

    // ── Read body (Buffer, O(n)) — only for POST ─────────────────────────────
    const bodyBuf = req.method === 'POST' ? await readBody(req) : null;

    syncStats();

    // ── Bulk path: Content-Type: application/json ─────────────────────────────
    if (req.headers['content-type'] === 'application/json') {
      if (!bodyBuf?.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Empty body' }));
      }

      let payload;
      try { payload = JSON.parse(bodyBuf); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }

      if (!Array.isArray(payload.jobs)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: "Expected JSON object with a 'jobs' array" }));
      }

      // Dispatch all jobs to the pool concurrently — pool queues internally.
      // No need for a separate acquireSlot() mechanism.
      const results = await Promise.all(payload.jobs.map(async (job) => {
        const t0  = Date.now();
        const fmt = job.format || 'png';

        try {
          const { buffer, mimeType } = await pool.render(job.svgText, fmt);
          recordJobDuration(Date.now() - t0);
          syncStats();
          return { id: job.id, status: 'success', mimeType, data: buffer.toString('base64') };

        } catch (resvgErr) {
          recordResvgFail();
          if (job.svgUrl) {
            try {
              recordWsrvFallback();
              const wsrvRes = await fetchFromWsrv(job.svgUrl, fmt);
              recordJobDuration(Date.now() - t0);
              const buf  = Buffer.from(await wsrvRes.arrayBuffer());
              const mime = wsrvRes.headers.get('content-type') || 'image/png';
              return { id: job.id, status: 'success', mimeType: mime, data: buf.toString('base64') };
            } catch (wsrvErr) {
              const msg = `resvg: ${resvgErr.message} | wsrv: ${wsrvErr.message}`;
              await logError('Bulk job failed', msg, [{ name: 'Job ID', value: String(job.id), inline: true }]);
              return { id: job.id, status: 'error', error: msg };
            }
          }
          await logError('Bulk job failed (no fallback URL)', resvgErr.message, [
            { name: 'Job ID', value: String(job.id), inline: true },
          ]);
          return { id: job.id, status: 'error', error: resvgErr.message };
        }
      }));

      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ results }));
    }

    // ── Single path ───────────────────────────────────────────────────────────

    let svgText;

    if (req.method === 'POST') {
      // Body already read as Buffer above
      if (!bodyBuf?.length) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('Empty SVG body');
      }
      svgText = bodyBuf.toString('utf8');

    } else if (req.method === 'GET') {
      const targetSvgUrl = params.get('url');
      if (!targetSvgUrl) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('Missing ?url= parameter');
      }
      const svgRes = await fetch(targetSvgUrl, {
        headers: { 'User-Agent': 'SpicyDevs-Rasterizer/2.0' },
        signal:  AbortSignal.timeout(8_000),
      });
      if (!svgRes.ok) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `SVG fetch failed: ${svgRes.status}` }));
      }
      svgText = await svgRes.text();

    } else {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      return res.end('Method not allowed');
    }

    // ── Render via pool (non-blocking) ────────────────────────────────────────
    const t0 = Date.now();
    try {
      const { buffer, mimeType } = await pool.render(svgText, format);
      recordJobDuration(Date.now() - t0);
      syncStats();
      // Write directly from the transferred Buffer — no extra copy
      res.writeHead(200, { 'Content-Type': mimeType, 'Cache-Control': 'public, max-age=86400' });
      res.end(buffer);

    } catch (resvgErr) {
      recordResvgFail();
      syncStats();

      if (fallbackUrl) {
        try {
          recordWsrvFallback();
          const wsrvRes = await fetchFromWsrv(fallbackUrl, format);
          recordJobDuration(Date.now() - t0);
          const buf  = Buffer.from(await wsrvRes.arrayBuffer());
          const mime = wsrvRes.headers.get('content-type') || 'image/png';
          res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
          res.end(buf);
        } catch (wsrvErr) {
          const msg = `resvg: ${resvgErr.message} | wsrv: ${wsrvErr.message}`;
          await logError('Single job failed', msg, [{ name: 'Format', value: format, inline: true }]);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: msg }));
        }
      } else {
        await logError('Single job failed (no fallback URL)', resvgErr.message, [
          { name: 'Format', value: format, inline: true },
        ]);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: resvgErr.message }));
      }
    }

  } catch (error) {
    await logError('Unhandled server error', error.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: error.message }));
  }
});

// ── HTTP socket tuning ────────────────────────────────────────────────────────
//
// setNoDelay(true):
//   Disables Nagle's algorithm.  Without this, the OS buffers small writes
//   for up to 40 ms waiting to combine them.  For our use case (write a
//   200–500 KB image then close) Nagle adds unnecessary latency on the
//   final ACK round-trip.
//
// keepAliveTimeout 65 s:
//   CF Workers / upstream proxies typically send keepalive probes every 60 s.
//   Setting our timeout above 60 s ensures the connection stays open across
//   those probes.  Without this, Node closes the socket just before the proxy
//   reuses it, causing a TCP RST + reconnect on every 60th second.
//
// headersTimeout 66 s:
//   Must exceed keepAliveTimeout to avoid Node closing a kept-alive connection
//   before the client sends its next request header.

server.keepAliveTimeout = 65_000;
server.headersTimeout   = 66_000;
server.requestTimeout   = 30_000;

server.on('connection', socket => {
  socket.setNoDelay(true); // flush immediately — no 40 ms Nagle delay
});

// ── Boot ──────────────────────────────────────────────────────────────────────

(async () => {
  const resvgOpts = await buildResvgOpts();
  console.log('[resvg] Font config:', JSON.stringify(resvgOpts.font, null, 2));

  // Spawn the pool — workers pre-warm their JIT during spawn
  pool = new RenderPool(MAX_CONCURRENT, resvgOpts);
  console.log(`[pool] ${MAX_CONCURRENT} worker threads ready`);

  server.listen(PORT, '0.0.0.0', async () => {
    console.log(`Rasterizer ready on port ${PORT} (${MAX_CONCURRENT} workers)`);
    await notifyOnline();
  });
})();

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

async function shutdown(signal) {
  console.log(`[${signal}] shutting down`);
  await notifyOffline(signal);
  if (pool) await pool.destroy();
  process.exit(0);
}