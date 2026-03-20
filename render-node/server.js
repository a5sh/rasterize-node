import http from 'node:http';
import { Resvg } from '@resvg/resvg-js';
import { processRequest } from '../core/logic.js';
import { stats, logError, notifyOnline, notifyOffline } from './discord.js';

const PORT = process.env.PORT || 3000;

// ── Concurrency limiter ───────────────────────────────────────────────────────
const MAX_CONCURRENT = 4;
let activeJobs = 0;
const jobQueue = [];

function acquireSlot() {
  return new Promise((resolve) => {
    if (activeJobs < MAX_CONCURRENT) {
      activeJobs++;
      resolve();
    } else {
      jobQueue.push(resolve);
    }
  });
}

function releaseSlot() {
  activeJobs--;
  if (jobQueue.length > 0) {
    activeJobs++;
    jobQueue.shift()();
  }
}

// Keep stats in sync with live counters
function syncStats() {
  stats.activeJobs = activeJobs;
  stats.queuedJobs = jobQueue.length;
}

// ── resvg options ─────────────────────────────────────────────────────────────
const RESVG_OPTS = {
  fitTo:          { mode: "original" },
  font:           { loadSystemFonts: false },
  imageRendering: 0,
};

// ── Render SVG to buffer (single .render() call) ──────────────────────────────
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

// ── wsrv.nl fallback ──────────────────────────────────────────────────────────
async function fetchFromWsrv(svgUrl, format) {
  const url = new URL("https://wsrv.nl/");
  url.searchParams.set("url",    svgUrl);
  url.searchParams.set("output", format === "webp" ? "webp" : format === "png" ? "png" : "jpg");
  url.searchParams.set("q",      "100");

  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), 6000);

  try {
    const res = await fetch(url.toString(), {
      signal:  ac.signal,
      headers: { "User-Agent": "SpicyDevs-Rasterizer/2.0" },
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

  try {
    const reqUrl      = `http://${req.headers.host}${req.url}`;
    const urlObj      = new URL(reqUrl);
    const getBodyText = () => new Promise((resolve) => {
      let body = '';
      req.on('data', (chunk) => body += chunk.toString());
      req.on('end',  () => resolve(body));
    });

    stats.requests++;
    syncStats();

    // ── Bulk path ─────────────────────────────────────────────────────────
    if (req.headers['content-type'] === 'application/json') {
      const bodyStr = await getBodyText();
      const payload = JSON.parse(bodyStr);

      if (!Array.isArray(payload.jobs)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: "Expected JSON object with a 'jobs' array" }));
      }

      const results = await Promise.all(payload.jobs.map(async (job) => {
        await acquireSlot();
        syncStats();
        try {
          const { buffer, mimeType } = renderToBuffer(job.svgText, job.format || 'png');
          return { id: job.id, status: 'success', mimeType, data: buffer.toString('base64') };
        } catch (resvgErr) {
          stats.resvgFails++;
          if (job.svgUrl) {
            try {
              stats.wsrvFallbacks++;
              const wsrvRes = await fetchFromWsrv(job.svgUrl, job.format || 'png');
              const buf     = Buffer.from(await wsrvRes.arrayBuffer());
              const mime    = wsrvRes.headers.get('content-type') || 'image/png';
              return { id: job.id, status: 'success', mimeType: mime, data: buf.toString('base64') };
            } catch (wsrvErr) {
              const msg = `resvg: ${resvgErr.message} | wsrv: ${wsrvErr.message}`;
              await logError('Bulk job failed (resvg + wsrv)', msg, [
                { name: 'Job ID', value: String(job.id), inline: true },
              ]);
              return { id: job.id, status: 'error', error: msg };
            }
          }
          await logError('Bulk job failed (resvg, no fallback URL)', resvgErr.message, [
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
    try {
      const { buffer, mimeType } = renderToBuffer(processed.svgText, format);
      res.writeHead(200, { 'Content-Type': mimeType, 'Cache-Control': 'public, max-age=86400' });
      res.end(buffer);
    } catch (resvgErr) {
      stats.resvgFails++;
      if (fallbackUrl) {
        try {
          stats.wsrvFallbacks++;
          const wsrvRes = await fetchFromWsrv(fallbackUrl, format);
          const buf     = Buffer.from(await wsrvRes.arrayBuffer());
          const mime    = wsrvRes.headers.get('content-type') || 'image/png';
          res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
          res.end(buf);
        } catch (wsrvErr) {
          const msg = `resvg: ${resvgErr.message} | wsrv: ${wsrvErr.message}`;
          await logError('Single job failed (resvg + wsrv)', msg, [
            { name: 'Format', value: format, inline: true },
          ]);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: msg }));
        }
      } else {
        await logError('Single job failed (resvg, no fallback URL)', resvgErr.message, [
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

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`Native Rasterizer running on port ${PORT}`);
  await notifyOnline();
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`[${signal}] shutting down`);
  await notifyOffline(signal);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));