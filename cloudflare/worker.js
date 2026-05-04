// cloudflare/worker.js
//
// CHANGES v5
// ─────────────────────────────────────────────────────────────────────────────
// • Expands <!--ICONS:key1,key2--> placeholder using bundled ICONS before render.
//   This keeps the SVG payload sent by the main Worker lean (~40 bytes vs ~20 KB)
//   while the rasterizer still receives full icon <symbol> elements.
// • expandIconPlaceholderSync() uses the bundled assets/icons.js — no fetch.
// • All prior v4 behaviour preserved (service binding + HTTP, X-Format, etc.)

import { initWasm, Resvg }              from '@resvg/resvg-wasm';
import resvgWasm                        from '@resvg/resvg-wasm/index_bg.wasm';
import fontBuffer                       from '../core/NotoSans-Subset.ttf';
import { applyFauxBold }                from '../core/fauxBold.js';
import { expandIconPlaceholderSync }    from '../core/iconCache.js';
import { ICONS }                        from '../assets/icons.js';
import puppeteer                        from '@cloudflare/puppeteer';

// ── WASM init ─────────────────────────────────────────────────────────────────

let wasmReady   = false;
let wasmPromise = null;

function ensureWasm() {
  if (wasmReady) return Promise.resolve();
  if (wasmPromise) return wasmPromise;
  wasmPromise = initWasm(resvgWasm)
    .then(() => { wasmReady = true; })
    .catch(e  => { wasmPromise = null; throw e; });
  return wasmPromise;
}

// ── resvg options ─────────────────────────────────────────────────────────────

const RESVG_OPTS = {
  fitTo: { mode: 'original' },
  font:  {
    loadSystemFonts:   false,
    defaultFontFamily: 'Noto Sans',
    sansSerifFamily:   'Noto Sans',
    serifFamily:       'Noto Sans',
    monospaceFamily:   'Noto Sans',
    fontBuffers:       [new Uint8Array(fontBuffer)],
  },
  imageRendering: 1,
};

// ── Main handler ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return jsonOk({ status: 'ok', version: '5.0', node: 'cloudflare', queueDepth: 0 });
    }

    if (url.pathname === '/ss') {
      return handleScreenshot(request, env);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin':  '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Format',
        },
      });
    }

    // ── Rasterisation routes ───────────────────────────────────────────────

    try {
      await ensureWasm();
    } catch (e) {
      return jsonError(503, `WASM init failed: ${e.message}`);
    }

    const formatHeader = request.headers.get('X-Format') || '';
    const formatParam  = url.searchParams.get('format')  || '';
    const format       = (['png','jpg','jpeg','webp'].find(f => f === (formatHeader || formatParam).toLowerCase())) || 'png';

    // ── Resolve SVG text ───────────────────────────────────────────────────
    let svgText;

    if (request.method === 'POST') {
      const ct = request.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        let payload;
        try   { payload = await request.json(); }
        catch { return jsonError(400, 'Invalid JSON'); }
        if (!payload?.svgText) return jsonError(400, 'Expected { svgText }');
        svgText = payload.svgText;
      } else {
        svgText = await request.text();
        if (!svgText?.trim()) return jsonError(400, 'Empty body');
      }
    } else if (request.method === 'GET') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) return jsonError(400, 'Missing ?url= parameter');
      try {
        const r = await fetch(targetUrl, { headers: { 'User-Agent': 'SpicyDevs-Rasterizer/5.0' } });
        if (!r.ok) return jsonError(502, `SVG fetch failed: ${r.status}`);
        svgText = await r.text();
      } catch (e) {
        return jsonError(502, `SVG fetch error: ${e.message}`);
      }
    } else {
      return jsonError(405, 'Method not allowed');
    }

    // ── Render ─────────────────────────────────────────────────────────────
    try {
      // 1. Expand icon placeholder using bundled ICONS (sync, no fetch needed)
      const withIcons  = expandIconPlaceholderSync(svgText, ICONS);
      // 2. Embed external poster image URLs as base64
      const embedded   = await embedExternalImages(withIcons);
      // 3. Faux-bold synthesis
      const processed  = applyFauxBold(embedded);
      // 4. Render
      const resvg      = new Resvg(processed, RESVG_OPTS);
      const rendered   = resvg.render();

      let imageBuffer, mimeType;

      if (format === 'jpg' || format === 'jpeg') {
        imageBuffer = typeof rendered.asJpeg === 'function' ? rendered.asJpeg(85) : rendered.asPng();
        mimeType    = typeof rendered.asJpeg === 'function' ? 'image/jpeg'        : 'image/png';
      } else if (format === 'webp') {
        imageBuffer = typeof rendered.asWebp === 'function' ? rendered.asWebp(85) : rendered.asPng();
        mimeType    = typeof rendered.asWebp === 'function' ? 'image/webp'        : 'image/png';
      } else {
        imageBuffer = rendered.asPng();
        mimeType    = 'image/png';
      }

      const response = new Response(imageBuffer, {
        status:  200,
        headers: {
          'Content-Type':                mimeType,
          'Cache-Control':               'public, max-age=86400',
          'Access-Control-Allow-Origin': '*',
          'X-Queue-Depth':               '0',
          'X-Node':                      'cloudflare',
        },
      });

      if (request.method === 'GET') {
        ctx.waitUntil(caches.default.put(request, response.clone()));
      }

      return response;
    } catch (e) {
      return jsonError(500, e instanceof Error ? e.message : String(e));
    }
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonOk(body) {
  return new Response(JSON.stringify(body), {
    status:  200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

/**
 * Embed external http(s) image hrefs as inline base64 data URIs.
 * Skips anything that already starts with data: (already embedded).
 */
async function embedExternalImages(svgText) {
  const matches = [...svgText.matchAll(/href="(https?:\/\/[^"]+)"/g)];
  if (matches.length === 0) return svgText;

  const uniqueUrls = [...new Set(matches.map(m => m[1]))];

  const replacements = await Promise.all(
    uniqueUrls.map(async url => {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'SpicyDevs-Rasterizer/5.0' },
          signal:  AbortSignal.timeout(8_000),
        });
        if (!res.ok) return { url, dataUri: null };

        const buf   = await res.arrayBuffer();
        const ct    = res.headers.get('content-type') || 'image/jpeg';
        const bytes = new Uint8Array(buf);
        const CHUNK = 0x8000;
        let binary  = '';
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return { url, dataUri: `data:${ct};base64,${btoa(binary)}` };
      } catch {
        return { url, dataUri: null };
      }
    }),
  );

  for (const { url, dataUri } of replacements) {
    if (dataUri) svgText = svgText.split(`href="${url}"`).join(`href="${dataUri}"`);
  }
  return svgText;
}

// ── /ss — headless screenshot ─────────────────────────────────────────────────

async function handleScreenshot(request, env) {
  const { searchParams } = new URL(request.url);
  const targetUrl = searchParams.get('url');
  if (!targetUrl) return jsonError(400, 'Missing ?url= parameter');

  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('bad protocol');
  } catch {
    return jsonError(400, 'Invalid URL — must be http or https');
  }

  const width    = Math.min(Math.max(parseInt(searchParams.get('width')   || '500',  10), 100), 3840);
  const height   = Math.min(Math.max(parseInt(searchParams.get('height')  || '750',  10), 100), 2160);
  const fullPage = searchParams.get('full') === '1';
  const format   = searchParams.get('format') === 'jpeg' ? 'jpeg' : 'png';
  const quality  = Math.min(Math.max(parseInt(searchParams.get('quality') || '85',   10), 1),   100);
  const waitMs   = Math.min(Math.max(parseInt(searchParams.get('wait')    || '0',    10), 0), 10_000);

  let browser;
  try {
    browser = await puppeteer.launch(env.MYBROWSER);
    const page = await browser.newPage();
    await page.setViewport({ width, height });

    await page.setRequestInterception(true);
    page.on('request', req => {
      const blocked = ['doubleclick.net', 'googlesyndication.com', 'adservice.google.com', 'google-analytics.com'];
      if (blocked.some(h => req.url().includes(h)) || ['media', 'websocket', 'manifest'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(parsedUrl.toString(), { waitUntil: 'load', timeout: 20_000 });
    if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));

    const opts = {
      type: format,
      ...(format === 'jpeg' ? { quality } : {}),
      ...(fullPage ? { fullPage: true } : { clip: { x: 0, y: 0, width, height } }),
    };
    const imageBuffer = await page.screenshot(opts);

    return new Response(imageBuffer, {
      status:  200,
      headers: {
        'Content-Type':                format === 'jpeg' ? 'image/jpeg' : 'image/png',
        'Cache-Control':               'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
        'X-Screenshot-URL':            parsedUrl.toString(),
      },
    });
  } catch (e) {
    return jsonError(500, e instanceof Error ? e.message : String(e));
  } finally {
    if (browser) await browser.close();
  }
}