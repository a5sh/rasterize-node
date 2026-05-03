// netlify/functions/rasterize.js
//
// FIXED v5 — Switched to @resvg/resvg-wasm to eliminate native-binary
// compatibility issues with Netlify's Lambda environment.
//
// WASM is initialised once at module load (Lambda cold start) via a
// Promise; subsequent warm invocations skip re-init.

import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { readFileSync }     from 'node:fs';
import { dirname, join }    from 'node:path';
import { fileURLToPath }    from 'node:url';
import { applyFauxBold }    from '../lib/fauxBold.js';
import { buildResvgOpts }   from '../lib/sharedRender.js';

const __dir      = dirname(fileURLToPath(import.meta.url));
const RESVG_OPTS = buildResvgOpts();

// ── WASM init (once per Lambda container) ─────────────────────────────────────
// The .wasm file is included via netlify.toml → included_files.
let wasmReady   = false;
let wasmPromise = null;

function ensureWasm() {
  if (wasmReady)   return Promise.resolve();
  if (wasmPromise) return wasmPromise;
  wasmPromise = (async () => {
    // Path: functions/ → ../ → node_modules/
    const wasmPath = join(__dir, '..', 'node_modules', '@resvg', 'resvg-wasm', 'index_bg.wasm');
    const wasmData = readFileSync(wasmPath);
    await initWasm(wasmData);
    wasmReady = true;
  })().catch(e => { wasmPromise = null; throw e; });
  return wasmPromise;
}

// ── Render helpers ────────────────────────────────────────────────────────────

async function embedExternalImages(svgText) {
  const matches = [...svgText.matchAll(/href="(https?:\/\/[^"]+)"/g)];
  if (!matches.length) return svgText;
  const unique = [...new Set(matches.map(m => m[1]))];
  const reps   = await Promise.all(unique.map(async url => {
    try {
      const res = await fetch(url, {
        signal:  AbortSignal.timeout(6000),
        headers: { 'User-Agent': 'SpicyDevs-Rasterizer/5.0' },
      });
      if (!res.ok) return { url, dataUri: null };
      const buf = Buffer.from(await res.arrayBuffer());
      const ct  = res.headers.get('content-type') || 'image/jpeg';
      return { url, dataUri: `data:${ct};base64,${buf.toString('base64')}` };
    } catch { return { url, dataUri: null }; }
  }));
  for (const { url, dataUri } of reps)
    if (dataUri) svgText = svgText.split(`href="${url}"`).join(`href="${dataUri}"`);
  return svgText;
}

async function renderToBuffer(svgText, format) {
  await ensureWasm();
  const embedded  = await embedExternalImages(svgText);
  const processed = applyFauxBold(embedded);
  const resvg     = new Resvg(processed, RESVG_OPTS);
  const rendered  = resvg.render();
  if ((format === 'jpg' || format === 'jpeg') && typeof rendered.asJpeg === 'function')
    return { buffer: rendered.asJpeg(85), mimeType: 'image/jpeg' };
  if (format === 'webp' && typeof rendered.asWebp === 'function')
    return { buffer: rendered.asWebp(85), mimeType: 'image/webp' };
  return { buffer: rendered.asPng(), mimeType: 'image/png' };
}

// ── Response helpers ──────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Format',
};

const jsonResp  = (code, body)    => ({ statusCode: code, headers: { 'Content-Type': 'application/json', ...CORS }, body: JSON.stringify(body) });
const imageResp = (buf, mime)     => ({
  statusCode:      200,
  headers:         { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400', 'X-Node': 'netlify', ...CORS },
  body:            Buffer.from(buf).toString('base64'),
  isBase64Encoded: true,
});

// ── Lambda handler ────────────────────────────────────────────────────────────

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const pathname = (event.path || '/').split('?')[0];
  const params   = new URLSearchParams(event.rawQuery || '');
  const format   = (
    event.headers['x-format'] ||
    params.get('format') ||
    'png'
  ).toLowerCase();

  // Health check
  if (pathname === '/health') {
    return jsonResp(200, {
      status:    'ok',
      version:   '5.0',
      node:      'netlify',
      wasmReady,
    });
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf-8')
    : (event.body || '');

  // ── JSON body ──────────────────────────────────────────────────────────
  if ((event.headers['content-type'] || '').includes('application/json')) {
    if (!rawBody) return jsonResp(400, { error: 'Empty body' });

    let payload;
    try   { payload = JSON.parse(rawBody); }
    catch { return jsonResp(400, { error: 'Invalid JSON' }); }

    // Single job
    if (payload.svgText) {
      const fmt = payload.format || format;
      try {
        const { buffer, mimeType } = await renderToBuffer(payload.svgText, fmt);
        return imageResp(buffer, mimeType);
      } catch (e) {
        return jsonResp(500, { error: e.message });
      }
    }

    // Bulk jobs
    if (Array.isArray(payload.jobs)) {
      const results = await Promise.all(payload.jobs.map(async job => {
        const fmt = job.format || 'png';
        try {
          const { buffer, mimeType } = await renderToBuffer(job.svgText, fmt);
          return { id: job.id, status: 'success', mimeType, data: Buffer.from(buffer).toString('base64') };
        } catch (e) {
          return { id: job.id, status: 'error', error: e.message };
        }
      }));
      return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS }, body: JSON.stringify({ results }) };
    }

    return jsonResp(400, { error: 'Expected { svgText } or { jobs: [] }' });
  }

  // ── GET ?url= ──────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const targetUrl = params.get('url');
    if (!targetUrl) return jsonResp(400, { error: 'Missing ?url= parameter' });
    try {
      const r = await fetch(targetUrl, {
        signal:  AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'SpicyDevs-Rasterizer/5.0' },
      });
      if (!r.ok) return jsonResp(502, { error: `SVG fetch failed: ${r.status}` });
      const svgText = await r.text();
      const { buffer, mimeType } = await renderToBuffer(svgText, format);
      return imageResp(buffer, mimeType);
    } catch (e) {
      return jsonResp(502, { error: e.message });
    }
  }

  // ── POST raw SVG ───────────────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    if (!rawBody) return jsonResp(400, { error: 'Empty SVG body' });
    try {
      const { buffer, mimeType } = await renderToBuffer(rawBody, format);
      return imageResp(buffer, mimeType);
    } catch (e) {
      return jsonResp(500, { error: e.message });
    }
  }

  return jsonResp(405, { error: 'Method not allowed' });
};