// cloudflare/worker.js
//
// Cloudflare Worker — SVG → PNG via @resvg/resvg-wasm.
// Wrangler bundles all ../core/ imports at deploy time; no lib/ copy needed.
//
// Font strategy: NotoSans-Subset.ttf is imported as a Data binding (see
// wrangler.jsonc rules) and passed as fontBuffers.  No system fonts are loaded.
// Bold text is handled by applyFauxBold() applied inside processRequest().

import { initWasm, Resvg }   from '@resvg/resvg-wasm';
import resvgWasm              from '@resvg/resvg-wasm/index_bg.wasm';
import fontBuffer             from '../core/NotoSans-Subset.ttf';
import { applyFauxBold }      from '../core/fauxBold.js';
import puppeteer              from '@cloudflare/puppeteer';

// ── WASM init (shared across concurrent cold-start requests) ──────────────────

let wasmInitialized = false;
let wasmInitPromise = null;

function getWasm() {
  if (wasmInitialized) return Promise.resolve();
  if (wasmInitPromise) return wasmInitPromise;

  wasmInitPromise = initWasm(resvgWasm)
    .then(() => { wasmInitialized = true; })
    .catch(e  => { wasmInitPromise = null; throw e; });

  return wasmInitPromise;
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
      return new Response(JSON.stringify({ status: 'ok', version: '3.0', node: 'cloudflare' }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
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
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // ── WASM init ─────────────────────────────────────────────────────────────
    try {
      await getWasm();
    } catch (e) {
      return jsonError(503, `WASM init failed: ${e.message}`);
    }

    // ── Resolve SVG text ──────────────────────────────────────────────────────
    let svgText;

    if (request.method === 'POST') {
      const ct = request.headers.get('content-type') || '';

      if (ct.includes('application/json')) {
        let payload;
        try { payload = await request.json(); }
        catch { return jsonError(400, 'Invalid JSON'); }

        // Single job shape sent by rasterBalancer
        if (payload.svgText) {
          svgText = payload.svgText;
        } else {
          return jsonError(400, 'Expected { svgText }');
        }
      } else {
        svgText = await request.text();
        if (!svgText) return jsonError(400, 'Empty body');
      }

    } else if (request.method === 'GET') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) return jsonError(400, 'Missing ?url= parameter');
      try {
        const r = await fetch(targetUrl, { headers: { 'User-Agent': 'SpicyDevs-Rasterizer/3.0' } });
        if (!r.ok) return jsonError(502, `SVG fetch failed: ${r.status}`);
        svgText = await r.text();
      } catch (e) {
        return jsonError(502, `SVG fetch error: ${e.message}`);
      }
    } else {
      return jsonError(405, 'Method not allowed');
    }

    // ── Render ────────────────────────────────────────────────────────────────
    try {
      const processed = applyFauxBold(svgText);
      const embedded  = await embedExternalImages(processed);
      const resvg     = new Resvg(embedded, RESVG_OPTS);
      const pngBuffer = resvg.render().asPng();

      const response = new Response(pngBuffer, {
        status:  200,
        headers: {
          'Content-Type':                'image/png',
          'Cache-Control':               'public, max-age=86400',
          'Access-Control-Allow-Origin': '*',
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

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

/**
 * Replace all external http(s) image hrefs with inline base64 data URIs
 * so resvg-wasm can render them (no filesystem access in CF Workers).
 */
async function embedExternalImages(svgText) {
  const matches = [...svgText.matchAll(/href="(https?:\/\/[^"]+)"/g)];
  if (matches.length === 0) return svgText;

  const uniqueUrls = [...new Set(matches.map(m => m[1]))];

  const replacements = await Promise.all(
    uniqueUrls.map(async url => {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'SpicyDevs-Rasterizer/3.0' },
          signal:  AbortSignal.timeout(8_000),
        });
        if (!res.ok) return { url, dataUri: null };
        const buf = await res.arrayBuffer();
        const ct  = res.headers.get('content-type') || 'image/jpeg';
        const bytes = new Uint8Array(buf);
        const CHUNK = 0x8000;
        let binary = '';
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
  const waitMs   = Math.min(Math.max(parseInt(searchParams.get('wait')    || '0',    10), 0),  10_000);

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