// cloudflare/worker.js — v8
//
// RASTERIZER + LOAD BALANCER
// ─────────────────────────────────────────────────────────────────────────────
// This worker now serves two roles:
//
//   1. WASM rasterizer  — used ONLY for simple requests (poster blur/grayscale,
//                         no ratings). Signalled by X-Simple: 1 header from the
//                         main API worker.
//
//   2. Load balancer    — all other rasterization requests are distributed to
//                         T1 nodes using 40/30/30 geo-weighted selection:
//
//        T1 pool:    US East (Vercel), DE20 (Spaceify), DE2 / Midas
//        Fallback:   wsrv.nl → EUC Render (last resort)
//
//        High-traffic detection: nodes that accumulate ≥3 errors/min are
//        deprioritised; the fallback chain absorbs the overflow naturally.
//
//        FR1 (fr1.spaceify.eu) is deprecated — not in rotation, b2p endpoint
//        calls are now handled via the main API /b2p route.
//
// INTERFACE (called by main API via env.RASTERIZER service binding)
// ─────────────────────────────────────────────────────────────────────────────
//   POST /
//     Body:          raw SVG text  (icons already expanded by main API worker)
//     X-Simple: 1   → WASM render
//     X-SVG-Url:    → canonical SVG URL (needed for Vercel URL-payload + wsrv)
//     X-CF-Colo:    → CF colo code of the original request (geo routing)
//     X-Format:     → output format (png | jpg | jpeg | webp)
//
// FLEET MONITORING (unchanged from v7)
// ─────────────────────────────────────────────────────────────────────────────
//   POST /report     ← T1 nodes POST metrics here
//   GET  /hub-test   ← debug: live fleet state + health polls
//   scheduled()      ← cron: refresh Discord embed

import { initWasm, Resvg }                             from '@resvg/resvg-wasm';
import resvgWasm                                        from '@resvg/resvg-wasm/index_bg.wasm';
import fontBuffer                                       from '../core/NotoSans-Subset.ttf';
import { applyFauxBold }                               from '../core/fauxBold.js';
import { expandIconPlaceholder, warmIconCache,
         iconCacheStatus }                             from '../core/iconCache.js';
import puppeteer                                        from '@cloudflare/puppeteer';

warmIconCache();

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

// ── RESVG options ─────────────────────────────────────────────────────────────

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

// ── Proxy allowlist ───────────────────────────────────────────────────────────

const PROXY_ALLOWLIST = [
  'http://fr1.spaceify.eu:25980',
  'http://de20.spaceify.eu:26100',
  'http://node-3.midas.host:25108',
];

// ══════════════════════════════════════════════════════════════════════════════
// ── T1 NODE POOL & LOAD BALANCER ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

const T1_NODES = [
  {
    id:          'us-east',
    url:         'https://us-r-vercel.vercel.app/api/rasterize',
    region:      'NA',
    useUrlPayload: true,   // GET ?url= path; avoids Vercel fast-origin-transfer cost
    acceptsGzip: false,
  },
  {
    id:          'de-20',
    url:         'http://de20.spaceify.eu:26100',
    region:      'EU',
    useUrlPayload: false,
    acceptsGzip: true,
  },
  {
    id:          'de-2',
    url:         'http://node-3.midas.host:25108',
    region:      'EU',
    useUrlPayload: false,
    acceptsGzip: true,
  },
];

// Fallback tier — wsrv is attempted first (no node overhead), then EUC
const EUC_NODE = {
  id:          'euc',
  url:         'https://euc-r-render.onrender.com',
  region:      'EU',
  useUrlPayload: false,
  acceptsGzip: true,
};

// ── Per-isolate health tracking ───────────────────────────────────────────────

const _errMap     = new Map();   // id → { count, windowEnd }
const _inflightMap = new Map();  // id → number

const ERR_WINDOW_MS        = 60_000;
const STRESS_THRESHOLD     = 3;   // errors/min → deprioritise
const FAILING_THRESHOLD    = 8;   // errors/min → skip in primary loop
const T1_TIMEOUT_MS        = 5_000;
const EUC_TIMEOUT_MS       = 10_000;
const WSRV_TIMEOUT_MS      = 5_000;

function _recordErr(id) {
  const now = Date.now();
  let e = _errMap.get(id);
  if (!e || now > e.windowEnd) e = { count: 0, windowEnd: now + ERR_WINDOW_MS };
  e.count++;
  _errMap.set(id, e);
}

function _recordOk(id) {
  const e = _errMap.get(id);
  if (e) e.count = Math.max(0, e.count - 1);
}

function _errCount(id) {
  const e = _errMap.get(id);
  return (!e || Date.now() > e.windowEnd) ? 0 : e.count;
}

function _isStressed(id)  { return _errCount(id) >= STRESS_THRESHOLD; }
function _isFailing(id)   { return _errCount(id) >= FAILING_THRESHOLD; }
function _acqIF(id)       { _inflightMap.set(id, (_inflightMap.get(id) || 0) + 1); }
function _relIF(id)       { _inflightMap.set(id, Math.max(0, (_inflightMap.get(id) || 0) - 1)); }
function _inFlight(id)    { return _inflightMap.get(id) || 0; }

// ── Geo region mapping ────────────────────────────────────────────────────────

const _COLO_REGION = (() => {
  const m = {};
  const zones = {
    NA: ['IAD','EWR','MIA','ORD','ATL','BOS','LAX','SFO','SEA','DFW','MSP',
         'PHX','DEN','PDX','LAS','SMF','SLC','OAK','SJC','DTW','PHL','CMH',
         'BUF','CLE','MSY','PIT','RDU','STL','OKC','KCI','OMA','TUL'],
    EU: ['LHR','CDG','AMS','DUB','FRA','ZRH','ARN','WAW','FCO','MAD','BCN',
         'MUC','DUS','HAM','BRU','GVA','CPH','OSL','HEL','LIS','VIE','PRG',
         'BUD','OTP','SOF','SKP','BEG','RIX','VNO','TLL','MXP','MAN'],
  };
  for (const [r, colos] of Object.entries(zones))
    for (const c of colos) m[c] = r;
  return m;
})();

function _region(colo) {
  return (colo && _COLO_REGION[colo.toUpperCase()]) || 'NA';
}

// ── Node order: geo-closest first, stressed nodes demoted ─────────────────────
//
// Base order:  EU → [de-20, de-2, us-east]  /  NA/else → [us-east, de-20, de-2]
// Sort key:    failing=2 > stressed=1 > healthy=0
// Result:      healthy nodes always precede stressed; failing nodes come last.
// Effectively: wsrv/EUC get promoted naturally when all T1 nodes are failing.

function _nodeOrder(colo) {
  const eu = _region(colo) === 'EU';
  const base = eu
    ? [T1_NODES[1], T1_NODES[2], T1_NODES[0]]   // de-20, de-2, us-east
    : [T1_NODES[0], T1_NODES[1], T1_NODES[2]];  // us-east, de-20, de-2
  return [...base].sort((a, b) => {
    const w = n => _isFailing(n.id) ? 2 : _isStressed(n.id) ? 1 : 0;
    return w(a) - w(b);
  });
}

// 40 / 30 / 30 probabilistic selection from the (already-sorted) ordered list.
function _pick(ordered) {
  if (!ordered.length) return null;
  const r = Math.random() * 100;
  if (r < 40 || ordered.length === 1) return ordered[0];
  if (r < 70 || ordered.length === 2) return ordered[1];
  return ordered[2];
}

// ── Gzip compression (CompressionStream — native in CF Workers) ───────────────

async function _gzip(text) {
  try {
    const ds = new CompressionStream('gzip');
    const w  = ds.writable.getWriter();
    w.write(new TextEncoder().encode(text));
    w.close();
    return await new Response(ds.readable).arrayBuffer();
  } catch { return null; }
}

// ── Single T1 / EUC node request ─────────────────────────────────────────────

async function _fetchNode(node, svgText, svgUrl, format, signal) {
  _acqIF(node.id);
  try {
    let res;
    if (node.useUrlPayload && svgUrl) {
      const u = new URL(node.url);
      u.searchParams.set('url',    svgUrl);
      u.searchParams.set('format', format);
      res = await fetch(u.toString(), {
        method:  'GET',
        headers: { 'User-Agent': 'SpicyDevs-LB/8.0' },
        signal,
      });
    } else {
      let body = svgText, ct = 'image/svg+xml';
      const extraHeaders = {};
      if (node.acceptsGzip) {
        const gz = await _gzip(svgText);
        if (gz) { body = gz; ct = 'application/octet-stream'; extraHeaders['X-SVG-Encoding'] = 'gzip'; }
      }
      res = await fetch(node.url, {
        method:  'POST',
        body,
        headers: { 'Content-Type': ct, 'X-Format': format, 'User-Agent': 'SpicyDevs-LB/8.0', ...extraHeaders },
        signal,
      });
    }
    if (!res.ok) { _recordErr(node.id); return null; }
    _recordOk(node.id);
    return res;
  } catch (e) {
    if (e?.name !== 'AbortError') _recordErr(node.id);
    return null;
  } finally { _relIF(node.id); }
}

// ── wsrv.nl fallback ──────────────────────────────────────────────────────────

async function _fetchWsrv(svgUrl, format) {
  if (!svgUrl) return null;
  try {
    // Rewrite to backend direct domain so wsrv can reach it; strip no_embed redirect
    const src = new URL(svgUrl);
    src.hostname = 'posterium-backend.aayu5h.workers.dev';
    src.searchParams.delete('no_embed');

    const u = new URL('https://wsrv.nl/');
    u.searchParams.set('url',    src.toString());
    u.searchParams.set('output', format === 'webp' ? 'webp' : (format === 'jpg' || format === 'jpeg') ? 'jpeg' : 'png');
    u.searchParams.set('q',      '100');

    const res = await fetch(u.toString(), { signal: AbortSignal.timeout(WSRV_TIMEOUT_MS) });
    return res.ok ? res : null;
  } catch { return null; }
}

// ── Build a uniform image Response from any upstream ─────────────────────────

function _imageResp(upstream, source, format) {
  const h = new Headers(upstream.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('X-Raster-Source',            source);
  h.set('Cache-Control',              'public, max-age=86400');
  h.set('X-Node',                     'cf-lb');
  return new Response(upstream.body, { status: 200, headers: h });
}

// ── Distributed render orchestrator ──────────────────────────────────────────
//
// 1. Select primary T1 node (40/30/30 weighted, geo-aware)
// 2. Try primary → try remaining T1 nodes sequentially
// 3. wsrv.nl fallback
// 4. EUC Render last resort
//
// Each T1 attempt gets T1_TIMEOUT_MS; EUC gets EUC_TIMEOUT_MS.
// All fallback logic lives here — individual nodes have no nested fallbacks.

async function _distributedRender(svgText, svgUrl, format, colo) {
  const ordered = _nodeOrder(colo);
  const primary = _pick(ordered);
  const rest    = ordered.filter(n => n !== primary);

  // Primary T1 attempt
  if (primary) {
    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), T1_TIMEOUT_MS);
    const res = await _fetchNode(primary, svgText, svgUrl, format, ac.signal).finally(() => clearTimeout(tm));
    if (res) return _imageResp(res, primary.id, format);
  }

  // Remaining T1 nodes
  for (const node of rest) {
    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), T1_TIMEOUT_MS);
    const res = await _fetchNode(node, svgText, svgUrl, format, ac.signal).finally(() => clearTimeout(tm));
    if (res) return _imageResp(res, node.id, format);
  }

  // wsrv.nl
  const wsrvRes = await _fetchWsrv(svgUrl, format);
  if (wsrvRes) return _imageResp(wsrvRes, 'wsrv', format);

  // EUC Render (last resort)
  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), EUC_TIMEOUT_MS);
  const eucRes = await _fetchNode(EUC_NODE, svgText, svgUrl, format, ac.signal).finally(() => clearTimeout(tm));
  if (eucRes) return _imageResp(eucRes, 'euc', format);

  return jsonError(502, 'All rasterizers exhausted');
}

// ══════════════════════════════════════════════════════════════════════════════
// ── IN-ISOLATE FLEET STATE (Discord hub — no KV, see v7 comments) ─────────────
// ══════════════════════════════════════════════════════════════════════════════

const _nodeMetrics = new Map();
let _lastDiscordUpdate = 0;
const DISCORD_MIN_INTERVAL_MS = 90_000;

// ── Main handler ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return jsonOk({
        status:     'ok',
        version:    '8.0',
        node:       'cloudflare',
        wasmReady,
        queueDepth: 0,
        iconCache:  iconCacheStatus(),
        fleetNodes: _nodeMetrics.size,
        t1Nodes:    T1_NODES.map(n => ({
          id:       n.id,
          errors:   _errCount(n.id),
          inFlight: _inFlight(n.id),
          stressed: _isStressed(n.id),
          failing:  _isFailing(n.id),
        })),
      });
    }

    if (url.pathname === '/hub-test') {
      const nodes = getNodes(env);
      const liveHealth = await Promise.all(
        nodes.map(n => fetchNodeHealth(n.url).then(h => ({ id: n.id, name: n.name, health: h }))),
      );
      return jsonOk({
        discordConfigured: !!env.DISCORD_WEBHOOK_URL,
        kvConfigured:      !!env.DASHBOARD_KV,
        lastDiscordUpdate: _lastDiscordUpdate ? new Date(_lastDiscordUpdate).toISOString() : null,
        configuredNodes:   nodes,
        storedMetricKeys:  [..._nodeMetrics.keys()],
        storedMetrics:     Object.fromEntries(_nodeMetrics),
        liveHealth,
        t1Pool: T1_NODES.map(n => ({ id: n.id, errors: _errCount(n.id), inFlight: _inFlight(n.id) })),
      });
    }

    if (url.pathname === '/report') {
      return handleReport(request, env, ctx);
    }

    if (url.pathname === '/ss') {
      return handleScreenshot(request, env);
    }

    if (url.pathname === '/proxy') {
      return handleProxy(request);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status:  204,
        headers: {
          'Access-Control-Allow-Origin':  '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Format, X-SVG-Encoding, X-Simple, X-SVG-Url, X-CF-Colo',
        },
      });
    }

    // ── Rasterisation entry point ─────────────────────────────────────────────
    //
    // X-Simple: 1   → WASM render (poster blur/grayscale only, no ratings)
    // (no header)   → distributed render via T1 pool

    const isSimple = request.headers.get('X-Simple') === '1';
    const svgUrl   = request.headers.get('X-SVG-Url')  || null;
    const colo     = request.headers.get('X-CF-Colo')  || request.cf?.colo || null;

    const formatHeader = request.headers.get('X-Format') || '';
    const formatParam  = url.searchParams.get('format')  || '';
    const format       = (['png','jpg','jpeg','webp'].find(
      f => f === (formatHeader || formatParam).toLowerCase(),
    )) || 'png';

    // ── Parse SVG body ───────────────────────────────────────────────────────
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
        const r = await fetch(targetUrl, { headers: { 'User-Agent': 'SpicyDevs-Rasterizer/8.0' } });
        if (!r.ok) return jsonError(502, `SVG fetch failed: ${r.status}`);
        svgText = await r.text();
      } catch (e) {
        return jsonError(502, `SVG fetch error: ${e.message}`);
      }
    } else {
      return jsonError(405, 'Method not allowed');
    }

    // ── Distributed render (all non-simple requests) ─────────────────────────
    if (!isSimple) {
      return _distributedRender(svgText, svgUrl, format, colo);
    }

    // ── WASM render (simple poster blur/grayscale, no ratings) ───────────────
    try { await ensureWasm(); }
    catch (e) { return jsonError(503, `WASM init failed: ${e.message}`); }

    try {
      const withIcons  = await expandIconPlaceholder(svgText);
      const embedded   = await embedExternalImages(withIcons);
      const processed  = applyFauxBold(embedded);
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
          'X-Node':                      'cloudflare-wasm',
          'X-Raster-Source':             'cf-wasm',
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

  // ── Cron trigger ─────────────────────────────────────────────────────────────
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(updateDashboard(env, true));
  },
};

// ── JSON helpers ──────────────────────────────────────────────────────────────

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

// ── External image embedding (WASM path only) ─────────────────────────────────

async function embedExternalImages(svgText) {
  const matches = [...svgText.matchAll(/href="(https?:\/\/[^"]+)"/g)];
  if (matches.length === 0) return svgText;

  const uniqueUrls = [...new Set(matches.map(m => m[1]))];

  const replacements = await Promise.all(
    uniqueUrls.map(async url => {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'SpicyDevs-Rasterizer/8.0' },
          signal:  AbortSignal.timeout(8_000),
        });
        if (!res.ok) return { url, dataUri: null };
        const buf   = await res.arrayBuffer();
        const ct    = res.headers.get('content-type') || 'image/jpeg';
        const bytes = new Uint8Array(buf);
        const CHUNK = 0x8000;
        let binary  = '';
        for (let i = 0; i < bytes.length; i += CHUNK)
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        return { url, dataUri: `data:${ct};base64,${btoa(binary)}` };
      } catch { return { url, dataUri: null }; }
    }),
  );

  for (const { url, dataUri } of replacements)
    if (dataUri) svgText = svgText.split(`href="${url}"`).join(`href="${dataUri}"`);
  return svgText;
}

// ── /proxy ────────────────────────────────────────────────────────────────────

async function handleProxy(request) {
  const url       = new URL(request.url);
  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) return jsonError(400, 'Missing ?url= parameter');

  const allowed = PROXY_ALLOWLIST.some(prefix => targetUrl.startsWith(prefix));
  if (!allowed) return jsonError(403, `Proxy target not in allowlist: ${targetUrl}`);

  const proxyHeaders = new Headers();
  for (const key of ['content-type', 'x-format', 'x-svg-encoding'])
    if (request.headers.get(key)) proxyHeaders.set(key, request.headers.get(key));
  proxyHeaders.set('User-Agent', 'SpicyDevs-Proxy/1.0');

  const init = { method: request.method, headers: proxyHeaders };
  if (request.method === 'POST') init.body = await request.arrayBuffer();

  let upstream;
  try { upstream = await fetch(targetUrl, init); }
  catch (e) { return jsonError(502, `Proxy fetch failed: ${e.message}`); }

  const respHeaders = new Headers(upstream.headers);
  respHeaders.set('Access-Control-Allow-Origin', '*');
  respHeaders.set('X-Proxied-Via',  'cf-worker');
  respHeaders.set('X-Proxy-Target', targetUrl);
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

// ── /ss ───────────────────────────────────────────────────────────────────────

async function handleScreenshot(request, env) {
  const { searchParams } = new URL(request.url);
  const targetUrl = searchParams.get('url');
  if (!targetUrl) return jsonError(400, 'Missing ?url= parameter');

  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
    if (!['http:','https:'].includes(parsedUrl.protocol)) throw new Error('bad protocol');
  } catch { return jsonError(400, 'Invalid URL — must be http or https'); }

  const width    = Math.min(Math.max(parseInt(searchParams.get('width')   || '500', 10), 100), 3840);
  const height   = Math.min(Math.max(parseInt(searchParams.get('height')  || '750', 10), 100), 2160);
  const fullPage = searchParams.get('full')    === '1';
  const format   = searchParams.get('format') === 'jpeg' ? 'jpeg' : 'png';
  const quality  = Math.min(Math.max(parseInt(searchParams.get('quality') || '85',  10), 1), 100);
  const waitMs   = Math.min(Math.max(parseInt(searchParams.get('wait')    || '0',   10), 0), 10_000);

  let browser;
  try {
    browser = await puppeteer.launch(env.MYBROWSER);
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.setRequestInterception(true);
    page.on('request', req => {
      const blocked = ['doubleclick.net','googlesyndication.com','adservice.google.com','google-analytics.com'];
      if (blocked.some(h => req.url().includes(h)) || ['media','websocket','manifest'].includes(req.resourceType()))
        req.abort(); else req.continue();
    });
    await page.goto(parsedUrl.toString(), { waitUntil: 'load', timeout: 20_000 });
    if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
    const opts      = { type: format, ...(format === 'jpeg' ? { quality } : {}), ...(fullPage ? { fullPage: true } : { clip: { x: 0, y: 0, width, height } }) };
    const imgBuffer = await page.screenshot(opts);
    return new Response(imgBuffer, {
      status:  200,
      headers: { 'Content-Type': format === 'jpeg' ? 'image/jpeg' : 'image/png', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*', 'X-Screenshot-URL': parsedUrl.toString() },
    });
  } catch (e) {
    return jsonError(500, e instanceof Error ? e.message : String(e));
  } finally {
    if (browser) await browser.close();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── DISCORD FLEET HUB (unchanged from v7) ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

async function handleReport(request, env, ctx) {
  if (request.method !== 'POST') return jsonError(405, 'POST only');
  let body;
  try { body = await request.json(); } catch { return jsonError(400, 'Invalid JSON'); }
  const { type, node, ts, stats, snapshot } = body;
  if (!node || !type) return jsonError(400, 'Missing node or type');
  _nodeMetrics.set(node, { node, type, ts: ts || Date.now(), stats: stats || null, snapshot: snapshot || null, lastError: stats?.lastError || null });
  const force = type === 'error' || type === 'offline';
  ctx.waitUntil(updateDashboard(env, force));
  return jsonOk({ received: true, type, node });
}

function getNodes(env) {
  const nodes = [];
  const add   = (id, name, url) => { if (url) nodes.push({ id, name, url }); };
  add('vercel-usw', 'Vercel USW',   env.VERCEL_NODE_URL);
  add('netlify',    'Netlify Ohio', env.NETLIFY_NODE_URL);
  add('render',     'Render',       env.RENDER_NODE_URL);
  add('vps-1',      'VPS 1',        env.VPS1_NODE_URL);
  add('vps-2',      'VPS 2',        env.VPS2_NODE_URL);
  add('vps-3',      'VPS 3',        env.VPS3_NODE_URL);
  return nodes;
}

async function fetchNodeHealth(url) {
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/health`, {
      headers: { 'User-Agent': 'SpicyDevs-Hub/8.0' },
      signal:  AbortSignal.timeout(6_000),
    });
    if (!res.ok) return { reachable: false, httpStatus: res.status };
    return { reachable: true, ...(await res.json()) };
  } catch (e) { return { reachable: false, error: e.message }; }
}

async function getMsgId(env) {
  if (!env.DASHBOARD_KV) return null;
  try { return await env.DASHBOARD_KV.get('cf:discord:msgId'); } catch { return null; }
}

async function setMsgId(env, id) {
  if (!env.DASHBOARD_KV) return;
  await env.DASHBOARD_KV.put('cf:discord:msgId', id).catch(() => {});
}

async function clearMsgId(env) {
  if (!env.DASHBOARD_KV) return;
  await env.DASHBOARD_KV.delete('cf:discord:msgId').catch(() => {});
}

function fmtUptime(s) {
  if (!s) return '—';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtRelTs(tsMs) { return tsMs ? `<t:${Math.floor(tsMs / 1000)}:R>` : 'never'; }

function statusEmoji(health) {
  if (!health.reachable || health.status === 'offline') return '🔴';
  if (health.status === 'degraded')                     return '🟠';
  return '🟢';
}

function findStoredMetrics(nodeId, nodeName) {
  return _nodeMetrics.get(nodeId) || _nodeMetrics.get(nodeName) || null;
}

function buildNodeFieldValue(health, stored) {
  const lines = [];
  if (!health.reachable) {
    const err = health.error ? health.error.slice(0, 80) : `HTTP ${health.httpStatus || '???'}`;
    lines.push(`❌ **Unreachable** — \`${err}\``);
    if (stored?.ts) lines.push(`Last report: ${fmtRelTs(stored.ts)}`);
    return lines.join('\n');
  }
  const row1 = [health.version ? `v${health.version}` : null, health.status || null, health.uptime ? `up ${fmtUptime(health.uptime)}` : null].filter(Boolean);
  if (row1.length) lines.push(row1.join(' · '));
  if (health.activeJobs !== undefined) {
    const row2 = [];
    if (health.workerCount)    row2.push(`${health.workerCount} workers`);
    row2.push(`${health.activeJobs} active`);
    if (health.queuedJobs)     row2.push(`${health.queuedJobs} queued`);
    if (health.pendingRespawns) row2.push(`⚠️ ${health.pendingRespawns} respawning`);
    lines.push(row2.join(' · '));
  }
  const cap = [];
  const fontOk = health.fontReady ?? (Array.isArray(health.fontFiles) ? health.fontFiles.length > 0 : undefined);
  if (fontOk !== undefined) cap.push(fontOk ? 'Font ✅' : 'Font ❌');
  if (health.iconCache?.loaded)       cap.push(`Icons: ${health.iconCache.iconCount}`);
  else if (health.iconCache?.lastError) cap.push('Icons ❌');
  if (cap.length) lines.push(cap.join(' · '));
  const snap = stored?.snapshot;
  if (snap) {
    if (snap.jobDuration?.n > 0) {
      const d = snap.jobDuration;
      lines.push(`Latency — p50 \`${d.p50}ms\` · p95 \`${d.p95}ms\` · p99 \`${d.p99}ms\` · max \`${d.max}ms\``);
    }
    if (snap.cpu?.n > 0) {
      lines.push(`CPU avg \`${snap.cpu.avg}%\` p95 \`${snap.cpu.p95}%\`` + (snap.mem?.n > 0 ? ` · Mem avg \`${snap.mem.avg}%\` p95 \`${snap.mem.p95}%\`` : ''));
    }
    if (snap.requests !== undefined) {
      const r = [`Req: **${snap.requests}**`, `Err: **${snap.errors}**`];
      if (snap.wsrvFallbacks) r.push(`wsrv: ${snap.wsrvFallbacks}`);
      if (snap.resvgFails)    r.push(`resvg fails: ${snap.resvgFails}`);
      lines.push(r.join(' · ') + ' _(last 5m)_');
    }
    if (snap.queueDepth?.max > 0) {
      lines.push(`Queue — avg \`${snap.queueDepth.avg}\` · p95 \`${snap.queueDepth.p95}\` · max \`${snap.queueDepth.max}\``);
    }
  }
  const lastErr = stored?.lastError || stored?.stats?.lastError;
  if (lastErr?.message) lines.push(`⚠️ Last err: \`${lastErr.message.slice(0, 100)}\` ${fmtRelTs(lastErr.ts)}`);
  if (stored?.ts && Date.now() - stored.ts > 15 * 60_000) lines.push(`_⏳ Metrics stale — last report ${fmtRelTs(stored.ts)}_`);
  return lines.join('\n') || '_(no data)_';
}

async function buildFleetEmbed(env, nodes) {
  const healthResults = await Promise.all(
    nodes.map(n => fetchNodeHealth(n.url).then(h => ({ ...n, health: h }))),
  );
  const cfEntry = {
    id: 'cloudflare', name: 'Cloudflare Edge',
    health: { reachable: true, status: 'online', version: '8.0', node: 'cloudflare', wasmReady, iconCache: iconCacheStatus() },
  };
  const allEntries = [cfEntry, ...healthResults];
  const online   = allEntries.filter(e => e.health.reachable && !['degraded','offline'].includes(e.health.status)).length;
  const degraded = allEntries.filter(e => e.health.reachable && e.health.status === 'degraded').length;
  const offline  = allEntries.filter(e => !e.health.reachable || e.health.status === 'offline').length;
  const color    = offline > 0 ? 0xe74c3c : degraded > 0 ? 0xe67e22 : 0x2ecc71;
  const fields   = [
    { name: '🟢 Online',   value: `\`${online}\``,   inline: true },
    { name: '🟠 Degraded', value: `\`${degraded}\``, inline: true },
    { name: '🔴 Offline',  value: `\`${offline}\``,  inline: true },
    ...allEntries.map(e => ({
      name:   `${statusEmoji(e.health)} ${e.name}`,
      value:  buildNodeFieldValue(e.health, findStoredMetrics(e.id, e.name)),
      inline: false,
    })),
  ];
  return {
    embeds: [{
      title:     '🎯 Posterium Rasterizer Fleet',
      color,
      fields,
      footer:    { text: `${allEntries.length} nodes · Hub: Cloudflare Edge v8 · LB: T1×3 + wsrv + EUC` },
      timestamp: new Date().toISOString(),
    }],
  };
}

async function discordPost(url, payload) {
  try {
    const res = await fetch(`${url}?wait=true`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body:   JSON.stringify(payload),
    });
    if (!res.ok) { console.error('[hub] Discord POST failed:', res.status); return null; }
    return res.json();
  } catch (e) { console.error('[hub] Discord POST error:', e.message); return null; }
}

async function discordPatch(url, msgId, payload) {
  try {
    const res = await fetch(`${url}/messages/${msgId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body:   JSON.stringify(payload),
    });
    return res.ok;
  } catch { return false; }
}

async function updateDashboard(env, force = false) {
  const webhookUrl = env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;
  if (!force && Date.now() - _lastDiscordUpdate < DISCORD_MIN_INTERVAL_MS) return;
  _lastDiscordUpdate = Date.now();
  const nodes = getNodes(env);
  let payload;
  try { payload = await buildFleetEmbed(env, nodes); }
  catch (e) { console.error('[hub] buildFleetEmbed error:', e.message); return; }
  let msgId = await getMsgId(env);
  if (msgId) {
    const ok = await discordPatch(webhookUrl, msgId, payload);
    if (!ok) { await clearMsgId(env); msgId = null; }
  }
  if (!msgId) {
    const msg = await discordPost(webhookUrl, payload);
    if (msg?.id) { await setMsgId(env, msg.id); console.log('[hub] Created dashboard message:', msg.id); }
  }
}