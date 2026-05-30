// cloudflare/worker.js — v9
//
// RASTERIZER + LOAD BALANCER
// ─────────────────────────────────────────────────────────────────────────────
// Roles:
//   1. WASM rasterizer  — X-Simple: 1 requests (poster blur/grayscale, no ratings)
//   2. Load balancer    — all other rasterization; staggered-concurrent T1 race:
//
//        T1 pool derived from assets/nodes.config.js (features.inLbWorker)
//        Fallback: wsrv.nl → EUC (features.isLbFallback)
//
//        Staggered race: primary starts at t=0, second at t=1.5s, third at t=2.5s.
//        First successful response wins and cancels the others.
//        This cuts worst-case latency vs sequential retry while still
//        conserving T1 node capacity when the primary responds quickly.
//
// ICON EXPANSION
// ─────────────────────────────────────────────────────────────────────────────
// The main API worker expands <!--ICONS:--> placeholders before sending SVG
// here via the service binding. This worker never needs to expand icons.
//
// INTERFACE
// ─────────────────────────────────────────────────────────────────────────────
//   POST /
//     Body:         raw SVG text (icons already expanded by main API worker)
//     X-Simple: 1  → WASM render
//     X-SVG-Url:   → canonical SVG URL (for URL-payload nodes + wsrv)
//     X-CF-Colo:   → CF colo of the original request (geo routing)
//     X-Format:    → output format

import { initWasm, Resvg } from '@resvg/resvg-wasm';
import resvgWasm           from '@resvg/resvg-wasm/index_bg.wasm';
import fontBuffer          from '../core/NotoSans-Subset.ttf';
import { applyFauxBold }   from '../core/fauxBold.js';
import NODE_CONFIG         from '../assets/nodes.config.js';
import puppeteer           from '@cloudflare/puppeteer';

// ── WASM init ─────────────────────────────────────────────────────────────────

let wasmReady   = false;
let wasmPromise = null;

function ensureWasm() {
  if (wasmReady)   return Promise.resolve();
  if (wasmPromise) return wasmPromise;
  wasmPromise = initWasm(resvgWasm)
    .then(() => { wasmReady = true; })
    .catch(e  => { wasmPromise = null; throw e; });
  return wasmPromise;
}

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
// ── T1 NODE POOL — derived from centralized config ────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Build the T1 pool and EUC fallback node from the shared nodes config.
 * Nodes are ordered by tier (lower = higher priority).
 */
const T1_NODES = NODE_CONFIG.nodes
  .filter(n => n.features.inLbWorker)
  .sort((a, b) => (a.specs.tier ?? 99) - (b.specs.tier ?? 99))
  .map(n => ({
    id:            n.id,
    // For URL-payload nodes include the API path; POST nodes use root.
    url:           `${n.url}${n.features.apiPath ?? ''}`,
    region:        n.lbRegion,
    useUrlPayload: n.features.useUrlPayload  ?? false,
    acceptsGzip:   n.features.acceptsCompression ?? false,
  }));

const EUC_NODE = (() => {
  const n = NODE_CONFIG.nodes.find(nd => nd.features.isLbFallback);
  if (!n) return null;
  return {
    id:          n.id,
    url:         `${n.url}${n.features.apiPath ?? ''}`,
    region:      n.lbRegion ?? 'EU',
    useUrlPayload: false,
    acceptsGzip: n.features.acceptsCompression ?? false,
  };
})();

const { t1TimeoutMs: T1_TIMEOUT_MS = 5_000, eucTimeoutMs: EUC_TIMEOUT_MS = 10_000,
        wsrvTimeoutMs: WSRV_TIMEOUT_MS = 5_000,
        staggerMs: STAGGER_MS = [0, 1_500, 2_500] } = NODE_CONFIG.settings;

// ── Per-isolate health tracking ───────────────────────────────────────────────

const _errMap      = new Map(); // id → { count, windowEnd }
const _inflightMap = new Map(); // id → number

const ERR_WINDOW_MS     = 60_000;
const STRESS_THRESHOLD  = 3;
const FAILING_THRESHOLD = 8;

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

function _isStressed(id) { return _errCount(id) >= STRESS_THRESHOLD;  }
function _isFailing(id)  { return _errCount(id) >= FAILING_THRESHOLD; }
function _acqIF(id)      { _inflightMap.set(id, (_inflightMap.get(id) || 0) + 1); }
function _relIF(id)      { _inflightMap.set(id, Math.max(0, (_inflightMap.get(id) || 0) - 1)); }
function _inFlight(id)   { return _inflightMap.get(id) || 0; }

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

/**
 * Return T1_NODES ordered geo-closest first, stressed nodes demoted,
 * failing nodes last.
 */
function _nodeOrder(colo) {
  const req   = _region(colo);
  const same  = T1_NODES.filter(n => n.region === req);
  const other = T1_NODES.filter(n => n.region !== req);
  return [...same, ...other].sort((a, b) => {
    const w = n => _isFailing(n.id) ? 2 : _isStressed(n.id) ? 1 : 0;
    return w(a) - w(b);
  });
}

// ── Gzip compression ──────────────────────────────────────────────────────────

async function _gzip(text) {
  try {
    const ds = new CompressionStream('gzip');
    const w  = ds.writable.getWriter();
    w.write(new TextEncoder().encode(text));
    w.close();
    return await new Response(ds.readable).arrayBuffer();
  } catch { return null; }
}

// ── Single node request ───────────────────────────────────────────────────────

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
        headers: { 'User-Agent': 'SpicyDevs-LB/9.0' },
        signal,
      });
    } else {
      let body = svgText, ct = 'image/svg+xml';
      const extraHeaders = {};
      if (node.acceptsGzip) {
        const gz = await _gzip(svgText);
        if (gz) {
          body = gz;
          ct   = 'application/octet-stream';
          extraHeaders['X-SVG-Encoding'] = 'gzip';
        }
      }
      res = await fetch(node.url, {
        method:  'POST',
        body,
        headers: { 'Content-Type': ct, 'X-Format': format, 'User-Agent': 'SpicyDevs-LB/9.0', ...extraHeaders },
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
    const src = new URL(svgUrl);
    src.hostname = 'posterium-backend.aayu5h.workers.dev';
    src.searchParams.delete('no_embed');

    const u = new URL('https://wsrv.nl/');
    u.searchParams.set('url',    src.toString());
    u.searchParams.set('output',
      format === 'webp' ? 'webp' : (format === 'jpg' || format === 'jpeg') ? 'jpeg' : 'png',
    );
    u.searchParams.set('q', '100');
    const res = await fetch(u.toString(), { signal: AbortSignal.timeout(WSRV_TIMEOUT_MS) });
    return res.ok ? res : null;
  } catch { return null; }
}

function _imageResp(upstream, source, format) {
  const h = new Headers(upstream.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('X-Raster-Source',            source);
  h.set('Cache-Control',              'public, max-age=86400');
  h.set('X-Node',                     'cf-lb');
  return new Response(upstream.body, { status: 200, headers: h });
}

const _sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Staggered-concurrent T1 race ──────────────────────────────────────────────
//
// All T1 nodes start within a window rather than sequentially:
//   Node 0: starts immediately
//   Node 1: starts after STAGGER_MS[1] (default 1.5s) if no winner yet
//   Node 2: starts after STAGGER_MS[2] (default 2.5s) if no winner yet
//
// The first successful response cancels all pending sibling requests via
// the shared raceAc AbortController.  Promise.any() resolves with the
// winner; rejects only when ALL nodes fail.
//
// Worst-case latency (vs sequential): 2.5s + T1_TIMEOUT_MS instead of
// 3 × T1_TIMEOUT_MS.  Best case: same as sending to the fastest node only.

async function _distributedRender(svgText, svgUrl, format, colo) {
  const ordered = _nodeOrder(colo);
  if (!ordered.length) {
    const wsrvRes = await _fetchWsrv(svgUrl, format);
    if (wsrvRes) return _imageResp(wsrvRes, 'wsrv', format);
    return jsonError(502, 'No T1 nodes configured');
  }

  const raceAc = new AbortController();

  const t1Promises = ordered.map((node, idx) => (async () => {
    if (idx > 0) {
      await _sleep(STAGGER_MS[idx] ?? STAGGER_MS[STAGGER_MS.length - 1]);
      if (raceAc.signal.aborted) throw new Error('race cancelled');
    }

    const nodeAc = new AbortController();
    raceAc.signal.addEventListener('abort', () => nodeAc.abort(), { once: true });
    const tm = setTimeout(() => nodeAc.abort(), T1_TIMEOUT_MS);

    try {
      const res = await _fetchNode(node, svgText, svgUrl, format, nodeAc.signal);
      clearTimeout(tm);
      if (!res) throw new Error('node returned null');
      raceAc.abort(); // cancel remaining staggered starts + in-flight siblings
      return _imageResp(res, node.id, format);
    } catch (e) {
      clearTimeout(tm);
      throw e;
    }
  })());

  try {
    return await Promise.any(t1Promises);
  } catch { /* all T1 failed */ }

  // wsrv.nl
  const wsrvRes = await _fetchWsrv(svgUrl, format);
  if (wsrvRes) return _imageResp(wsrvRes, 'wsrv', format);

  // EUC last resort
  if (EUC_NODE) {
    const eucAc = new AbortController();
    const eucTm = setTimeout(() => eucAc.abort(), EUC_TIMEOUT_MS);
    const eucRes = await _fetchNode(EUC_NODE, svgText, svgUrl, format, eucAc.signal)
      .finally(() => clearTimeout(eucTm));
    if (eucRes) return _imageResp(eucRes, EUC_NODE.id, format);
  }

  return jsonError(502, 'All rasterizers exhausted');
}

// ══════════════════════════════════════════════════════════════════════════════
// ── FLEET MONITORING STATE ────────────────────────────────────────────────────
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
        version:    '9.0',
        node:       'cloudflare',
        wasmReady,
        queueDepth: 0,
        t1Pool: T1_NODES.map(n => ({
          id:       n.id,
          errors:   _errCount(n.id),
          inFlight: _inFlight(n.id),
          stressed: _isStressed(n.id),
          failing:  _isFailing(n.id),
        })),
        eucNode:    EUC_NODE?.id ?? null,
        fleetNodes: _nodeMetrics.size,
      });
    }

    if (url.pathname === '/hub-test') {
      const nodes      = getNodes(env);
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

    if (url.pathname === '/report') return handleReport(request, env, ctx);
    if (url.pathname === '/ss')     return handleScreenshot(request, env);
    if (url.pathname === '/proxy')  return handleProxy(request);

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

    // ── Rasterization entry point ─────────────────────────────────────────────
    const isSimple     = request.headers.get('X-Simple')  === '1';
    const svgUrl       = request.headers.get('X-SVG-Url') || null;
    const colo         = request.headers.get('X-CF-Colo') || request.cf?.colo || null;
    const formatHeader = request.headers.get('X-Format')  || '';
    const formatParam  = url.searchParams.get('format')   || '';
    const format       = (['png','jpg','jpeg','webp'].find(
      f => f === (formatHeader || formatParam).toLowerCase(),
    )) || 'png';

    // ── Parse SVG body ────────────────────────────────────────────────────────
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
        const r = await fetch(targetUrl, { headers: { 'User-Agent': 'SpicyDevs-Rasterizer/9.0' } });
        if (!r.ok) return jsonError(502, `SVG fetch failed: ${r.status}`);
        svgText = await r.text();
      } catch (e) {
        return jsonError(502, `SVG fetch error: ${e.message}`);
      }
    } else {
      return jsonError(405, 'Method not allowed');
    }

    // ── Distributed render (all non-simple) ───────────────────────────────────
    if (!isSimple) {
      return _distributedRender(svgText, svgUrl, format, colo);
    }

    // ── WASM render (simple: poster blur/grayscale, no ratings) ───────────────
    try { await ensureWasm(); }
    catch (e) { return jsonError(503, `WASM init failed: ${e.message}`); }

    try {
      // Icons are already expanded by the main API worker — no expansion needed here.
      const embedded  = await embedExternalImages(svgText);
      const processed = applyFauxBold(embedded);
      const resvg     = new Resvg(processed, RESVG_OPTS);
      const rendered  = resvg.render();

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
      if (request.method === 'GET') ctx.waitUntil(caches.default.put(request, response.clone()));
      return response;
    } catch (e) {
      return jsonError(500, e instanceof Error ? e.message : String(e));
    }
  },

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
          headers: { 'User-Agent': 'SpicyDevs-Rasterizer/9.0' },
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
  const targetUrl = url.
  searchParams.get('url');
  if (!targetUrl) return jsonError(400, 'Missing ?url= parameter');
  if (!PROXY_ALLOWLIST.some(prefix => targetUrl.startsWith(prefix)))
    return jsonError(403, `Proxy target not in allowlist: ${targetUrl}`);

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
// ── DISCORD FLEET HUB (unchanged) ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

async function handleReport(request, env, ctx) {
  if (request.method !== 'POST') return jsonError(405, 'POST only');
  let body;
  try { body = await request.json(); } catch { return jsonError(400, 'Invalid JSON'); }
  const { type, node, ts, stats, snapshot } = body;
  if (!node || !type) return jsonError(400, 'Missing node or type');
  _nodeMetrics.set(node, { node, type, ts: ts || Date.now(), stats: stats || null, snapshot: snapshot || null, lastError: stats?.lastError || null });
  ctx.waitUntil(updateDashboard(env, type === 'error' || type === 'offline'));
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
      headers: { 'User-Agent': 'SpicyDevs-Hub/9.0' },
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
    if (health.workerCount)     row2.push(`${health.workerCount} workers`);
    row2.push(`${health.activeJobs} active`);
    if (health.queuedJobs)      row2.push(`${health.queuedJobs} queued`);
    if (health.pendingRespawns) row2.push(`⚠️ ${health.pendingRespawns} respawning`);
    lines.push(row2.join(' · '));
  }
  const cap = [];
  const fontOk = health.fontReady ?? (Array.isArray(health.fontFiles) ? health.fontFiles.length > 0 : undefined);
  if (fontOk !== undefined) cap.push(fontOk ? 'Font ✅' : 'Font ❌');
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
    health: { reachable: true, status: 'online', version: '9.0', node: 'cloudflare', wasmReady },
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
      footer:    { text: `${allEntries.length} nodes · Hub: CF Edge v9 · T1: ${T1_NODES.length} nodes + wsrv + ${EUC_NODE?.id ?? 'no-euc'}` },
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