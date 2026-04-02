// vps/server.js
//
// Generic Node.js VPS / Pterodactyl / Railway / Fly.io server.
// Identical logic to render/server.js — kept separate so each can have its
// own discord.js with platform-specific env vars.
//
// lib/ is populated by the start script or manually:
//   node ../scripts/build.mjs vps

import http                     from 'node:http';
import path, { dirname, join }  from 'node:path';
import { fileURLToPath }        from 'node:url';
import { RenderPool }           from './lib/renderPool.js';
import { buildResvgOpts }       from './lib/sharedRender.js';
import {
  stats, logError, notifyOnline, notifyOffline,
  recordRequest, recordJobDuration, recordResvgFail, recordWsrvFallback,
} from './discord.js';

const PORT           = parseInt(process.env.PORT           || '3000', 10);
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '4',    10);

const __dir       = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dir, 'lib', 'renderWorker.js');

async function fetchFromWsrv(svgUrl, format) {
  const u = new URL('https://wsrv.nl/');
  u.searchParams.set('url',    svgUrl);
  u.searchParams.set('output', format === 'webp' ? 'webp' : format === 'png' ? 'png' : 'jpg');
  u.searchParams.set('q',      '100');
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), 6_000);
  try {
    const res = await fetch(u.toString(), { signal: ac.signal, headers: { 'User-Agent': 'SpicyDevs-Rasterizer/3.0' } });
    clearTimeout(t);
    if (!res.ok) throw new Error(`wsrv.nl returned ${res.status}`);
    return res;
  } catch (e) { clearTimeout(t); throw e; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data',  c  => chunks.push(c));
    req.on('end',   () => resolve(Buffer.concat(chunks)));
    req.on('error', err => { err._clientAbort = true; reject(err); });
    req.on('close', () => {
      if (!req.complete) reject(Object.assign(new Error('aborted'), { _clientAbort: true }));
    });
  });
}

let pool = null;
function syncStats() {
  if (!pool) return;
  stats.activeJobs = pool.activeJobs;
  stats.queuedJobs = pool.queuedJobs;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  const qIdx     = req.url.indexOf('?');
  const pathname = qIdx === -1 ? req.url : req.url.slice(0, qIdx);
  const search   = qIdx === -1 ? ''      : req.url.slice(qIdx);

  if (pathname === '/health') {
    syncStats();
    const fontCfg = pool?._resvgOpts?.font ?? null;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({
      status: 'ok', version: '3.0', node: 'vps', ts: Date.now(),
      activeJobs: stats.activeJobs, queuedJobs: stats.queuedJobs,
      workerCount: pool?.workerCount ?? 0, pendingRespawns: pool?.pendingRespawns ?? 0,
      maxConcurrent: MAX_CONCURRENT, uptime: Math.floor(process.uptime()),
      fontDefault: fontCfg?.defaultFontFamily ?? null, fontFiles: fontCfg?.fontFiles ?? [],
    }));
  }

  if (!pool) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Initialising — retry in a moment.' }));
  }

  try {
    recordRequest();
    const params      = new URLSearchParams(search);
    const format      = params.get('format')       || 'png';
    const fallbackUrl = params.get('fallback_url') || null;
    const bodyBuf     = req.method === 'POST' ? await readBody(req) : null;
    syncStats();

    if (req.headers['content-type'] === 'application/json') {
      if (!bodyBuf?.length) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Empty body' })); }
      let payload;
      try { payload = JSON.parse(bodyBuf); }
      catch { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }

      if (payload.svgText) {
        const fmt = payload.format || format;
        const t0  = Date.now();
        try {
          const { buffer, mimeType } = await pool.render(payload.svgText, fmt);
          recordJobDuration(Date.now() - t0); syncStats();
          res.writeHead(200, { 'Content-Type': mimeType, 'Cache-Control': 'public, max-age=86400' });
          return res.end(buffer);
        } catch (resvgErr) {
          recordResvgFail(); syncStats();
          const fallback = payload.svgUrl || fallbackUrl;
          if (fallback) {
            try {
              recordWsrvFallback();
              const wsrvRes = await fetchFromWsrv(fallback, fmt);
              recordJobDuration(Date.now() - t0);
              const buf = Buffer.from(await wsrvRes.arrayBuffer());
              res.writeHead(200, { 'Content-Type': wsrvRes.headers.get('content-type') || 'image/png', 'Cache-Control': 'public, max-age=86400' });
              return res.end(buf);
            } catch (wsrvErr) {
              const msg = `resvg: ${resvgErr.message} | wsrv: ${wsrvErr.message}`;
              await logError('Single JSON job failed', msg);
              res.writeHead(502, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: msg }));
            }
          }
          await logError('Single JSON job failed (no fallback)', resvgErr.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: resvgErr.message }));
        }
      }

      if (!Array.isArray(payload.jobs)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: "Expected { svgText } or { jobs: [] }" }));
      }

      const results = await Promise.all(payload.jobs.map(async job => {
        const t0 = Date.now(), fmt = job.format || 'png';
        try {
          const { buffer, mimeType } = await pool.render(job.svgText, fmt);
          recordJobDuration(Date.now() - t0); syncStats();
          return { id: job.id, status: 'success', mimeType, data: buffer.toString('base64') };
        } catch (resvgErr) {
          recordResvgFail();
          if (job.svgUrl) {
            try {
              recordWsrvFallback();
              const wsrvRes = await fetchFromWsrv(job.svgUrl, fmt);
              recordJobDuration(Date.now() - t0);
              const buf = Buffer.from(await wsrvRes.arrayBuffer());
              return { id: job.id, status: 'success', mimeType: wsrvRes.headers.get('content-type') || 'image/png', data: buf.toString('base64') };
            } catch (wsrvErr) {
              return { id: job.id, status: 'error', error: `resvg: ${resvgErr.message} | wsrv: ${wsrvErr.message}` };
            }
          }
          return { id: job.id, status: 'error', error: resvgErr.message };
        }
      }));

      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ results }));
    }

    let svgText;
    if (req.method === 'POST') {
      if (!bodyBuf?.length) { res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('Empty SVG body'); }
      svgText = bodyBuf.toString('utf8');
    } else if (req.method === 'GET') {
      const targetUrl = params.get('url');
      if (!targetUrl) { res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('Missing ?url= parameter'); }
      const r = await fetch(targetUrl, { headers: { 'User-Agent': 'SpicyDevs-Rasterizer/3.0' }, signal: AbortSignal.timeout(8_000) });
      if (!r.ok) { res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: `SVG fetch failed: ${r.status}` })); }
      svgText = await r.text();
    } else {
      res.writeHead(405, { 'Content-Type': 'text/plain' }); return res.end('Method not allowed');
    }

    const t0 = Date.now();
    try {
      const { buffer, mimeType } = await pool.render(svgText, format);
      recordJobDuration(Date.now() - t0); syncStats();
      res.writeHead(200, { 'Content-Type': mimeType, 'Cache-Control': 'public, max-age=86400' });
      res.end(buffer);
    } catch (resvgErr) {
      recordResvgFail(); syncStats();
      if (fallbackUrl) {
        try {
          recordWsrvFallback();
          const wsrvRes = await fetchFromWsrv(fallbackUrl, format);
          recordJobDuration(Date.now() - t0);
          const buf = Buffer.from(await wsrvRes.arrayBuffer());
          res.writeHead(200, { 'Content-Type': wsrvRes.headers.get('content-type') || 'image/png', 'Cache-Control': 'public, max-age=86400' });
          res.end(buf);
        } catch (wsrvErr) {
          const msg = `resvg: ${resvgErr.message} | wsrv: ${wsrvErr.message}`;
          await logError('Single job failed', msg);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: msg }));
        }
      } else {
        await logError('Single job failed (no fallback)', resvgErr.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: resvgErr.message }));
      }
    }

  } catch (error) {
    if (error._clientAbort) return;
    await logError('Unhandled server error', error.message);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
});

server.keepAliveTimeout = 65_000;
server.headersTimeout   = 66_000;
server.requestTimeout   = 30_000;
server.on('connection', s => s.setNoDelay(true));

(async () => {
  const resvgOpts = buildResvgOpts();
  console.log('[resvg] Font config:', JSON.stringify(resvgOpts.font, null, 2));

  pool = new RenderPool(WORKER_PATH, __dir, MAX_CONCURRENT, resvgOpts);
  console.log(`[pool]  ${MAX_CONCURRENT} worker threads spawned`);

  server.listen(PORT, '0.0.0.0', async () => {
    console.log(`Rasterizer ready on :${PORT} (${MAX_CONCURRENT} workers)`);
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