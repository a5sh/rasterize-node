// node/index.js
//
// Generic Node.js rasterizer — works on any host (Pterodactyl, Railway, Fly.io, VPS, etc.)
//
// Deployment layout expected at runtime:
//   index.js          ← this file
//   discord.js        ← sibling
//   core/logic.js     ← shared request handler
//
// Key env vars:
//   PORT              – HTTP port (default 3000)
//   MAX_CONCURRENT    – max parallel render jobs (default 4)
//   FONT_DIR          – colon-separated list of font directories (optional)
//   NODE_NAME         – display name shown in Discord dashboard (optional)
//   DISCORD_WEBHOOK_URL – Discord webhook for monitoring (optional)

import http from 'node:http';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { processRequest } from '../core/logic.js';
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

const PORT = process.env.PORT || 3000;

// ── Font resolution ────────────────────────────────────────────────────────────
// Strategy (in order):
//   1. FONT_DIR env var  – explicit colon-separated list
//   2. Common system dirs – covers Ubuntu, Debian, Alpine, macOS dev
//   3. HTTP download fallback – grabs NotoSans-Regular.ttf to /tmp

const SYSTEM_FONT_DIRS = [
  // Ubuntu / Debian (apt install fonts-liberation2 fonts-noto-core)
  '/usr/share/fonts/truetype/liberation2',
  '/usr/share/fonts/truetype/liberation',
  '/usr/share/fonts/truetype/noto',
  '/usr/share/fonts/opentype/noto',
  '/usr/share/fonts/truetype',
  '/usr/share/fonts',
  '/usr/local/share/fonts',
  // Alpine
  '/usr/share/fonts/noto',
  // macOS (local dev)
  '/Library/Fonts',
  '/System/Library/Fonts',
];

function existsDir(d) {
  try { return fs.statSync(d).isDirectory(); } catch { return false; }
}

async function resolveFont() {
  // 1. Explicit override
  if (process.env.FONT_DIR) {
    const dirs = process.env.FONT_DIR.split(':').filter(existsDir);
    if (dirs.length) { console.log('[font] FONT_DIR:', dirs); return { fontDirs: dirs }; }
  }

  // 2. System dirs
  const dirs = SYSTEM_FONT_DIRS.filter(existsDir);
  if (dirs.length) { console.log('[font] System dirs found:', dirs); return { fontDirs: dirs }; }

  // 3. Download fallback
  console.warn('[font] No system font dirs found — downloading NotoSans fallback…');
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
  const result = await resolveFont();

  const isLiberation = result.fontDirs?.some(d => d.includes('liberation'));
  const isNoto       = result.fontDirs?.some(d => d.includes('noto')) || result.fontFiles?.length > 0;
  const defaultFamily = isLiberation ? 'Liberation Sans' : 'Noto Sans';

  return {
    fitTo:          { mode: 'original' },
    imageRendering: 0,
    font: {
      loadSystemFonts: false,
      ...result,
      defaultFontFamily: defaultFamily,
      sansSerifFamily:   defaultFamily,
      serifFamily:       isLiberation ? 'Liberation Serif' : defaultFamily,
      monospaceFamily:   isLiberation ? 'Liberation Mono'  : defaultFamily,
    },
  };
}

// ── Concurrency limiter ───────────────────────────────────────────────────────
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '4', 10);
let activeJobs = 0;
const jobQueue = [];

function acquireSlot() {
  return new Promise(resolve => {
    if (activeJobs < MAX_CONCURRENT) { activeJobs++; resolve(); }
    else jobQueue.push(resolve);
  });
}

function releaseSlot() {
  activeJobs--;
  if (jobQueue.length > 0) { activeJobs++; jobQueue.shift()(); }
}

function syncStats() {
  stats.activeJobs = activeJobs;
  stats.queuedJobs = jobQueue.length;
}

// ── Render SVG → buffer ───────────────────────────────────────────────────────
let RESVG_OPTS = null;

function renderToBuffer(svgText, format) {
  const resvg    = new Resvg(svgText, RESVG_OPTS);
  const rendered = resvg.render();

  if ((format === 'jpg' || format === 'jpeg') && typeof rendered.asJpeg === 'function')
    return { buffer: rendered.asJpeg(85), mimeType: 'image/jpeg' };
  if (format === 'webp' && typeof rendered.asWebp === 'function')
    return { buffer: rendered.asWebp(85), mimeType: 'image/webp' };
  return { buffer: rendered.asPng(), mimeType: 'image/png' };
}

// ── wsrv.nl fallback ──────────────────────────────────────────────────────────
async function fetchFromWsrv(svgUrl, format) {
  const url = new URL('https://wsrv.nl/');
  url.searchParams.set('url',    svgUrl);
  url.searchParams.set('output', format === 'webp' ? 'webp' : format === 'png' ? 'png' : 'jpg');
  url.searchParams.set('q',      '100');

  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), 6000);
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

  const reqUrl = `http://${req.headers.host}${req.url}`;
  const urlObj = new URL(reqUrl);

  // ── Health check ──────────────────────────────────────────────────────────
  if (urlObj.pathname === '/health') {
    const fontCfg = RESVG_OPTS?.font ?? null;
    res.writeHead(200, {
      'Content-Type':  'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma':        'no-cache',
      'Expires':       '0',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(JSON.stringify({
      status:        'ok',
      version:       '2.0',
      ts:            Date.now(),
      activeJobs,
      queuedJobs:    jobQueue.length,
      maxConcurrent: MAX_CONCURRENT,
      uptime:        Math.floor(process.uptime()),
      fontsReady:    RESVG_OPTS !== null,
      fontDefault:   fontCfg?.defaultFontFamily ?? null,
      fontDirs:      fontCfg?.fontDirs  ?? [],
      fontFiles:     fontCfg?.fontFiles ?? [],
    }));
  }

  if (!RESVG_OPTS) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Initialising — retry in a moment.' }));
  }

  try {
    const getBodyText = () =>
      new Promise(resolve => {
        let body = '';
        req.on('data', c => (body += c.toString()));
        req.on('end',  () => resolve(body));
      });

    recordRequest();
    syncStats();

    // ── Bulk path ─────────────────────────────────────────────────────────
    if (req.headers['content-type'] === 'application/json') {
      const payload = JSON.parse(await getBodyText());
      if (!Array.isArray(payload.jobs)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: "Expected JSON object with a 'jobs' array" }));
      }

      const results = await Promise.all(payload.jobs.map(async job => {
        await acquireSlot();
        syncStats();
        const t0 = Date.now();
        try {
          const { buffer, mimeType } = renderToBuffer(job.svgText, job.format || 'png');
          recordJobDuration(Date.now() - t0);
          return { id: job.id, status: 'success', mimeType, data: buffer.toString('base64') };
        } catch (resvgErr) {
          recordResvgFail();
          if (job.svgUrl) {
            try {
              recordWsrvFallback();
              const wsrvRes = await fetchFromWsrv(job.svgUrl, job.format || 'png');
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
        } finally {
          releaseSlot();
          syncStats();
        }
      }));

      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ results }));
    }

    // ── Single path ───────────────────────────────────────────────────────
    const processed = await processRequest(reqUrl, req.method, req.headers, getBodyText, process.env);
    if (processed.status !== 200 || !processed.svgText) {
      res.writeHead(processed.status, { 'Content-Type': processed.contentType || 'text/plain' });
      return res.end(processed.body);
    }

    const format      = urlObj.searchParams.get('format') || 'png';
    const fallbackUrl = urlObj.searchParams.get('fallback_url') || null;

    await acquireSlot();
    syncStats();
    const t0 = Date.now();
    try {
      const { buffer, mimeType } = renderToBuffer(processed.svgText, format);
      recordJobDuration(Date.now() - t0);
      res.writeHead(200, { 'Content-Type': mimeType, 'Cache-Control': 'public, max-age=86400' });
      res.end(buffer);
    } catch (resvgErr) {
      recordResvgFail();
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
    } finally {
      releaseSlot();
      syncStats();
    }
  } catch (error) {
    await logError('Unhandled server error', error.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  RESVG_OPTS = await buildResvgOpts();
  console.log('[resvg] Font config:', JSON.stringify(RESVG_OPTS.font, null, 2));

  server.listen(PORT, '0.0.0.0', async () => {
    console.log(`Rasterizer ready on port ${PORT} (MAX_CONCURRENT=${MAX_CONCURRENT})`);
    await notifyOnline();
  });
})();

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

async function shutdown(signal) {
  console.log(`[${signal}] shutting down`);
  await notifyOffline(signal);
  process.exit(0);
}