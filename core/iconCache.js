// core/iconCache.js
//
// Shared icon-cache module for every Node.js rasterizer platform
// (Vercel, Netlify, Render, VPS).
//
// HOW IT FITS IN
// ──────────────
// The CF Worker SVG generator no longer inlines icon <symbol> bodies inside
// the SVG it POSTs to rasterizer nodes.  Instead it emits a compact placeholder:
//
//   <!--ICONS:imdb,rt_fresh,age-->
//
// This module:
//   1. On first call, fetches https://api.posterium.xyz/data/icons (JSON)
//      and caches the result in-process for 24 h.
//   2. expandIconPlaceholder(svgText) replaces the placeholder with the real
//      <symbol> elements before the SVG is handed to resvg.
//
// The fetch is coalesced (only one in-flight at a time) so a burst of
// concurrent requests on a cold lambda does not spam the API.
//
// FALLBACK
// ────────
// If the API is unreachable, expandIconPlaceholder returns the SVG unchanged.
// resvg will still render — badges simply show no icons (pill + text only).
// The next request retries the fetch.

const ICONS_API_URL = "https://api.posterium.xyz/data/icons";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
const FETCH_TIMEOUT = 5_000; // 5 s

let _cache = null; // { [key]: { vb, body } }
let _fetchedAt = 0;
let _inflight = null; // single shared Promise during fetch
let _lastError = null; // last fetch error, cleared on success

// ── Icon fetching ─────────────────────────────────────────────────────────────

export async function getIcons() {
  const now = Date.now();

  // Cache hit
  if (_cache && now - _fetchedAt < CACHE_TTL_MS) return _cache;

  // Coalesce concurrent callers
  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      const res = await fetch(ICONS_API_URL, {
        headers: { "User-Agent": "SpicyDevs-Rasterizer/5.0" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      if (!res.ok) throw new Error(`Icons API returned ${res.status}`);
      _cache = await res.json();
      _fetchedAt = Date.now();
      _lastError = null;
      console.log(
        `[iconCache] Loaded ${Object.keys(_cache).length} icons from API`,
      );
      return _cache;
    } catch (err) {
      _lastError = err.message;
      console.warn(
        `[iconCache] Fetch failed: ${err.message}${_cache ? " — using stale cache" : " — no fallback"}`,
      );
      // Return stale cache if available, null otherwise
      return _cache;
    } finally {
      _inflight = null;
    }
  })();

  return _inflight;
}

/**
 * Eagerly warm the icon cache at server startup.
 * Call from server.js / function handler — fire-and-forget.
 */
export function warmIconCache() {
  getIcons().catch(() => {}); // errors already logged inside getIcons
}

// ── Placeholder expansion ─────────────────────────────────────────────────────

const PLACEHOLDER_RE = /<!--ICONS:([^-]*)-->/;

/**
 * Asynchronous version for Node.js rasterizer nodes.
 * Fetches icon data from the API if not already cached.
 *
 * @param {string} svgText
 * @returns {Promise<string>}
 */
export async function expandIconPlaceholder(svgText) {
  if (!PLACEHOLDER_RE.test(svgText)) return svgText;

  const icons = await getIcons();
  if (!icons) return svgText; // fallback: pass through unchanged

  return _expand(svgText, icons);
}

/**
 * Synchronous version for the CF Worker (which has ICONS bundled).
 * No network call needed.
 *
 * @param {string} svgText
 * @param {object} icons  - the ICONS map from assets/icons.js
 * @returns {string}
 */
export function expandIconPlaceholderSync(svgText, icons) {
  if (!PLACEHOLDER_RE.test(svgText)) return svgText;
  return _expand(svgText, icons);
}

function _expand(svgText, icons) {
  return svgText.replace(PLACEHOLDER_RE, (_, keys) => {
    return keys
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean)
      .filter((k) => icons[k])
      .map(
        (k) =>
          `<symbol id="i-${k}" viewBox="${icons[k].vb}">${icons[k].body}</symbol>`,
      )
      .join("");
  });
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

export function iconCacheStatus() {
  return {
    loaded: !!_cache,
    iconCount: _cache ? Object.keys(_cache).length : 0,
    fetchedAt: _fetchedAt || null,
    ageMs: _fetchedAt ? Date.now() - _fetchedAt : null,
    lastError: _lastError,
    inflight: !!_inflight,
  };
}
