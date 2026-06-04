// cloudflare/worker.js — v10
//
// RASTERIZER + LOAD BALANCER
// ─────────────────────────────────────────────────────────────────────────────
// Roles:
//   1. WASM rasterizer  — X-Simple: 1 requests (poster blur/grayscale, no ratings)
//                       — GET ?url= requests  (mirrors all other nodes' own-renderer path)
//   2. Load balancer    — all POST requests without X-Simple: 1; sequential T1 fallback:
//
//        T1 pool (geo-ordered, nodes.config.js inLbWorker):
//          Node 0 — geo-closest (≈40% of traffic)
//          Node 1 — first fallback (≈30%)
//          Node 2 — second fallback (≈30%)
//        Each T1 acts as fallback for the others in sequence.
//
//        On all-T1 failure → EUC (T2, isLbFallback)
//        On EUC failure    → wsrv.nl (ALWAYS before TMDB redirect)
//        On wsrv failure   → 302 to X-Fallback-Image-Url (original TMDB poster)
//
// INTERFACE
// ─────────────────────────────────────────────────────────────────────────────
//   POST /
//     Body:                   raw SVG text
//     X-Simple: 1            → WASM render
//     X-SVG-Url:             → canonical SVG URL (for wsrv)
//     X-CF-Colo:             → CF colo of the original request (geo routing)
//     X-Format:              → output format
//     X-Fallback-Image-Url:  → original TMDB poster URL (last-resort redirect)
//
//   GET /?url=<svg_url>[&format=png|jpg|webp][&_debug=1]
//                            → WASM render (mirrors other nodes' own ?url= path)
//     _debug=1               → return JSON timing breakdown instead of image
//
//   GET /perf               → WASM benchmark: renders a fixed test SVG,
//                             returns JSON with wasm_init_ms / render_ms / total_wall_ms

import { initWasm, Resvg }  from '@resvg/resvg-wasm';
import resvgWasm            from '@resvg/resvg-wasm/index_bg.wasm';
import fontBuffer           from '../core/NotoSans-Subset.ttf';
import { applyFauxBold }    from '../core/fauxBold.js';
import NODE_CONFIG          from '../assets/nodes.config.js';
import puppeteer            from '@cloudflare/puppeteer';

// ── Structured logger ─────────────────────────────────────────────────────────

function _log(level, event, meta = {}) {
  const entry = { ts: new Date().toISOString(), level, event, node: 'cf-rasterizer', ...meta };
  if (level === 'error') console.error(JSON.stringify(entry));
  else                   console.log(JSON.stringify(entry));
}

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
  imageRendering: 0,
};

// ── Proxy allowlist ───────────────────────────────────────────────────────────

const PROXY_ALLOWLIST = [
  'http://fr1.spaceify.eu:25980',
  'http://de20.spaceify.eu:26100',
  'http://node-3.midas.host:25108',
];

// ══════════════════════════════════════════════════════════════════════════════
// ── T1 NODE POOL ──────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

const T1_NODES = NODE_CONFIG.nodes
  .filter(n => n.features.inLbWorker)
  .sort((a, b) => (a.specs.tier ?? 99) - (b.specs.tier ?? 99))
  .map(n => ({
    id:            n.id,
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

const {
  t1TimeoutMs:   T1_TIMEOUT_MS  = 5_000,
  eucTimeoutMs:  EUC_TIMEOUT_MS = 10_000,
  wsrvTimeoutMs: WSRV_TIMEOUT_MS = 5_000,
} = NODE_CONFIG.settings;

// ── Per-isolate health tracking ───────────────────────────────────────────────

const _errMap      = new Map();
const _inflightMap = new Map();

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
 * Return T1_NODES ordered geo-closest first, stressed/failing nodes demoted.
 * This naturally produces a 40/30/30 traffic distribution — the closest node
 * handles ~40% of requests (it almost always succeeds), the others catch
 * successive failures.
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
        headers: { 'User-Agent': 'SpicyDevs-LB/10.0' },
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
        headers: { 'Content-Type': ct, 'X-Format': format, 'User-Agent': 'SpicyDevs-LB/10.0', ...extraHeaders },
        signal,
      });
    }
    if (!res.ok) {
      _recordErr(node.id);
      _log('warn', 'node_http_error', { node: node.id, status: res.status });
      return null;
    }
    _recordOk(node.id);
    return res;
  } catch (e) {
    if (e?.name !== 'AbortError') {
      _recordErr(node.id);
      _log('error', 'node_fetch_threw', { node: node.id, error: e?.message });
    }
    return null;
  } finally {
    _relIF(node.id);
  }
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
    if (!res.ok) {
      _log('warn', 'wsrv_http_error', { status: res.status });
      return null;
    }
    return res;
  } catch (e) {
    _log('error', 'wsrv_fetch_threw', { error: e?.message });
    return null;
  }
}

// ── Image response helper ─────────────────────────────────────────────────────

function _imageResp(upstream, source, format) {
  const h = new Headers(upstream.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('X-Raster-Source',            source);
  h.set('Cache-Control',              'public, max-age=86400');
  h.set('X-Node',                     'cf-lb');
  return new Response(upstream.body, { status: 200, headers: h });
}

// ══════════════════════════════════════════════════════════════════════════════
// ── SEQUENTIAL T1 FALLBACK  (40 / 30 / 30 distribution)
// ══════════════════════════════════════════════════════════════════════════════
//
// Chain: T1[0] → T1[1] → T1[2] → EUC(T2) → wsrv.nl → 302 TMDB
//
// Each step is tried only if the previous one fails.  The geo-closest T1 node
// gets ~40% of requests (it succeeds most of the time); the second and third
// each absorb ~30% of the failures.  wsrv.nl is ALWAYS tried before
// redirecting to the TMDB fallback image URL.

async function _distributedRender(svgText, svgUrl, format, colo, fallbackImageUrl) {
  const ordered = _nodeOrder(colo);

  if (!ordered.length) {
    _log('warn', 'no_t1_nodes_configured', { colo });
    return _wsrvOrRedirect(svgUrl, format, fallbackImageUrl, 'no_t1_nodes');
  }

  // ── Sequential T1 fallback ────────────────────────────────────────────────
  for (let i = 0; i < ordered.length; i++) {
    const node = ordered[i];
    _log('info', 't1_attempt', {
      node:    node.id,
      attempt: i + 1,
      total:   ordered.length,
      colo,
      errors:  _errCount(node.id),
    });

    const nodeAc = new AbortController();
    const tm     = setTimeout(() => nodeAc.abort(), T1_TIMEOUT_MS);
    let res = null;
    try {
      res = await _fetchNode(node, svgText, svgUrl, format, nodeAc.signal);
    } catch (e) {
      _log('error', 't1_unexpected_throw', { node: node.id, attempt: i + 1, error: e?.message });
    } finally {
      clearTimeout(tm);
    }

    if (res) {
      _log('info', 't1_success', { node: node.id, attempt: i + 1 });
      return _imageResp(res, node.id, format);
    }

    const next = ordered[i + 1]?.id ?? (EUC_NODE ? 'euc' : 'wsrv');
    _log('warn', 't1_failed', { node: node.id, attempt: i + 1, falling_to: next });
  }

  // ── EUC / T2 fallback ─────────────────────────────────────────────────────
  if (EUC_NODE) {
    _log('warn', 'euc_attempt', { node: EUC_NODE.id, reason: 'all_t1_failed' });
    const eucAc = new AbortController();
    const eucTm = setTimeout(() => eucAc.abort(), EUC_TIMEOUT_MS);
    let eucRes = null;
    try {
      eucRes = await _fetchNode(EUC_NODE, svgText, svgUrl, format, eucAc.signal);
    } catch (e) {
      _log('error', 'euc_unexpected_throw', { node: EUC_NODE.id, error: e?.message });
    } finally {
      clearTimeout(eucTm);
    }

    if (eucRes) {
      _log('info', 'euc_success', { node: EUC_NODE.id });
      return _imageResp(eucRes, EUC_NODE.id, format);
    }
    _log('error', 'euc_failed', { node: EUC_NODE.id });
  } else {
    _log('warn', 'euc_not_configured', {});
  }

  // ── wsrv.nl → TMDB redirect ───────────────────────────────────────────────
  return _wsrvOrRedirect(svgUrl, format, fallbackImageUrl, 'all_nodes_exhausted');
}

/**
 * Always tries wsrv.nl first.  Only redirects to the original TMDB poster
 * image when wsrv also fails.  Logs every step.
 */
async function _wsrvOrRedirect(svgUrl, format, fallbackImageUrl, reason) {
  _log('warn', 'wsrv_attempt', { reason, svgUrl: (svgUrl || '').slice(0, 120) });

  const wsrvRes = await _fetchWsrv(svgUrl, format);
  if (wsrvRes) {
    _log('info', 'wsrv_success', { reason });
    return _imageResp(wsrvRes, 'wsrv', format);
  }

  _log('error', 'wsrv_failed', { reason });

  // Last resort — redirect to original TMDB poster image
  if (fallbackImageUrl) {
    _log('warn', 'tmdb_redirect_issued', {
      reason,
      url: fallbackImageUrl.slice(0, 120),
    });
    return new Response(null, {
      status: 302,
      headers: {
        'Location':                    fallbackImageUrl,
        'Access-Control-Allow-Origin': '*',
        'X-Raster-Source':             'tmdb-fallback-redirect',
        'X-Failure-Reason':            reason,
        'Cache-Control':               'no-store',
      },
    });
  }

  _log('error', 'chain_fully_exhausted', { reason, note: 'no_fallback_image_url' });
  return jsonError(502, 'All rasterizers exhausted');
}

// ══════════════════════════════════════════════════════════════════════════════
// ── FLEET MONITORING STATE ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

const _nodeMetrics = new Map();
let _lastDiscordUpdate = 0;
const DISCORD_MIN_INTERVAL_MS = 90_000;

// ══════════════════════════════════════════════════════════════════════════════
// ── WASM PERFORMANCE BENCHMARK ────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
//
// GET /perf  — renders a fixed two-badge SVG through the WASM pipeline and
// returns JSON with per-stage timing.  Never cached (Cache-Control: no-store).
// Useful for cold-start vs warm comparisons and cross-region benchmarking.

const _PERF_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750" viewBox="0 0 500 750">
  <rect width="500" height="750" fill="#1a1a1a"/>
  <rect x="30" y="30"  width="140" height="60" rx="12" fill="rgba(0,0,0,0.45)"/>
  <text x="100" y="61" dy="0.35em" text-anchor="middle"
        font-family="Noto Sans,Arial,sans-serif" font-size="28"
        font-weight="bold" fill="#ffffff">8.5</text>
  <rect x="30" y="110" width="140" height="60" rx="12" fill="rgba(0,0,0,0.45)"/>
  <text x="100" y="141" dy="0.35em" text-anchor="middle"
        font-family="Noto Sans,Arial,sans-serif" font-size="28"
        font-weight="bold" fill="#f5c518">7.2</text>
</svg>`;

async function handlePerf(request) {
  const t0   = Date.now();
  const colo = request.cf?.colo ?? null;

  // Ensure WASM is initialised (may be a cold start).
  // tWasmMs ≈ 0 on warm isolates where wasmReady is already true.
  try { await ensureWasm(); }
  catch (e) {
    return new Response(JSON.stringify({ error: `WASM init failed: ${e.message}` }), {
      status:  503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
    });
  }
  const tWasmMs = Date.now() - t0;

  try {
    // No embedExternalImages call — the bench SVG has no external hrefs.
    const tRender0  = Date.now();
    const processed = applyFauxBold(_PERF_SVG);
    const resvg     = new Resvg(processed, RESVG_OPTS);
    const rendered  = resvg.render();
    const tRenderMs = Date.now() - tRender0;

    const tEncode0  = Date.now();
    const png       = rendered.asPng();
    const tEncodeMs = Date.now() - tEncode0;

    const tTotalMs  = Date.now() - t0;

    return new Response(JSON.stringify({
      status:    'ok',
      node:      'cloudflare-wasm',
      colo,
      wasmReady,
      timing: {
        wasm_init_ms:  tWasmMs,  // ≈0 on warm isolate
        render_ms:     tRenderMs,
        encode_ms:     tEncodeMs,
        total_wall_ms: tTotalMs,
      },
      output: {
        width:  rendered.width,
        height: rendered.height,
        bytes:  png.byteLength,
      },
    }), {
      status:  200,
      headers: {
        'Content-Type':                'application/json',
        'Cache-Control':               'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: `Perf render failed: ${e instanceof Error ? e.message : String(e)}` }), {
      status:  500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return jsonOk({
        status:     'ok',
        version:    '10.0',
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

    if (url.pathname === '/perf')   return handlePerf(request);
    if (url.pathname === '/report') return handleReport(request, env, ctx);
    if (url.pathname === '/ss')     return handleScreenshot(request, env);
    if (url.pathname === '/proxy')  return handleProxy(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status:  204,
        headers: {
          'Access-Control-Allow-Origin':  '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Format, X-SVG-Encoding, X-Simple, X-SVG-Url, X-CF-Colo, X-Fallback-Image-Url',
        },
      });
    }

    // ── Rasterization entry point ─────────────────────────────────────────────
    const tWall0            = Date.now();
    const debugMode         = url.searchParams.get('_debug') === '1';
    const isSimple          = request.headers.get('X-Simple')            === '1';
    const svgUrl            = request.headers.get('X-SVG-Url')           || null;
    const colo 
