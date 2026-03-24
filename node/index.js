// render-node/server.js
// (apply identical changes to node/index.js — copy renderWorker.js there too)

import http                from 'node:http';
import fs                  from 'node:fs';
import os                  from 'node:os';
import path, { dirname, join } from 'node:path';
import { fileURLToPath }   from 'node:url';
import { RenderPool }      from '../core/renderPool.js';
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
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || 4, 10);

const __dir       = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dir, '../core/renderWorker.js');
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
  const result        = await resolveFont();
  const isLiberation  = result.fontDirs?.some(d => d.includes('liberation'));
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

// ── Body reader (O(n) Buffer concat) ─────────────────────────────────────────

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

// ── Pool + stats ──────────────────────────────────────────────────────────────

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

  const qIdx     = req.url.indexOf('?');
  const pathname = qIdx === -1 ? req.url : req.url.slice(0, qIdx);
  const search   = qIdx === -1 ? ''      : req.url.slice(qIdx);

  // ── Health check ──────────────────────────────────────────────────────────
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

  if (!pool) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Initialising — retry in a moment.' }));
  }

  try {
    recordRequest();

    const params      = new URLSearchParams(search);
    const format      = params.get('format') || 'png';
    const fallbackUrl = params.get('fallback_url') || null;

    const bodyBuf = req.method === 'POST' ? await readBody(req) : null;
    syncStats();

    // ── Bulk path ─────────────────────────────────────────────────────────────
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

      const results = await Promise.all(payload.jobs.map(async job => {
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

    const t0 = Date.now();
    try {
      const { buffer, mimeType } = await pool.render(svgText, format);
      recordJobDuration(Date.now() - t0);
      syncStats();
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

server.keepAliveTimeout = 65_000;
server.headersTimeout   = 66_000;
server.requestTimeout   = 30_000;

server.on('connection', socket => socket.setNoDelay(true));

// ── Boot ──────────────────────────────────────────────────────────────────────

(async () => {
  const resvgOpts = await buildResvgOpts();
  console.log('[resvg] Font config:', JSON.stringify(resvgOpts.font, null, 2));

  // Pass WORKER_PATH so RenderPool spawns workers next to node_modules/
  pool = new RenderPool(WORKER_PATH, __dir, MAX_CONCURRENT, resvgOpts);
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