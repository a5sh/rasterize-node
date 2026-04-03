// lib/cache.js — in-memory LRU caches for icons and posters

// ── Icon SVG cache (permanent — icons never change) ───────────────────────────
// Stores the rendered PNG bytes of commonly used provider icons.
// These are fetched from TMDB/fanart alongside the SVG and embedded,
// but the SVG icon symbols themselves are always the same.
// More importantly: cache the PROCESSED SVG text with faux-bold applied
// so we don't re-apply applyFauxBold() on every request for the same SVG.

const _processedSvgCache = new Map(); // hash(svgText) → processed SVG
const _MAX_SVG_CACHE     = 200;       // keep last 200 unique SVGs in RAM

export function getCachedSvg(key) { return _processedSvgCache.get(key) ?? null; }
export function setCachedSvg(key, processed) {
  if (_processedSvgCache.size >= _MAX_SVG_CACHE) {
    _processedSvgCache.delete(_processedSvgCache.keys().next().value);
  }
  _processedSvgCache.set(key, processed);
}

// ── Poster image cache (5-minute TTL, 100 entries) ───────────────────────────
// Avoids re-fetching the same TMDB poster image within a short window.
// Key = URL, value = { data: Buffer, ct: string, expiry: number }

const _posterCache = new Map();
const POSTER_TTL   = 5 * 60_000; // 5 minutes
const MAX_POSTERS  = 100;

export function getCachedPoster(url) {
  const entry = _posterCache.get(url);
  if (!entry || Date.now() > entry.expiry) {
    _posterCache.delete(url);
    return null;
  }
  return entry;
}

export function setCachedPoster(url, data, contentType) {
  if (_posterCache.size >= MAX_POSTERS) {
    _posterCache.delete(_posterCache.keys().next().value);
  }
  _posterCache.set(url, { data, ct: contentType, expiry: Date.now() + POSTER_TTL });
}