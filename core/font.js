/**
 * core/font.js
 *
 * Edge-compatible font loader for @resvg/resvg-wasm environments.
 *
 * In edge runtimes (Cloudflare Workers, Vercel Edge, Netlify Edge Functions)
 * there is no filesystem, so fonts cannot be loaded from disk.
 * This module fetches a TTF font once, caches it as a base64 string, and
 * provides a helper to embed it inside an SVG via @font-face so that
 * resvg-wasm can render text correctly.
 *
 * Usage (in each edge handler):
 *   import { loadEdgeFont, injectFontIntoSvg, EDGE_FONT_FAMILY } from '../../core/font.js';
 *   let fontPromise = null;
 *   // inside handler:
 *   if (!fontPromise) fontPromise = loadEdgeFont();
 *   const fontBase64 = await fontPromise;
 *   const svgText = injectFontIntoSvg(processed.svgText, fontBase64);
 *   const resvg = new Resvg(svgText, { font: { loadSystemFonts: false, defaultFontFamily: EDGE_FONT_FAMILY } });
 */

const FONT_TTF_URL =
  'https://github.com/notofonts/notofonts.github.io/raw/main/fonts/NotoSans/hinted/ttf/NotoSans-Regular.ttf';

export const EDGE_FONT_FAMILY = 'Noto Sans';

let _fontBase64Promise = null;

/**
 * Fetches the NotoSans TTF font and returns it as a base64 string (cached).
 * Returns null on failure — text will be invisible but rendering won't crash.
 */
export function loadEdgeFont() {
  if (!_fontBase64Promise) {
    _fontBase64Promise = fetch(FONT_TTF_URL, { signal: AbortSignal.timeout(20_000) })
      .then(r => {
        if (!r.ok) throw new Error(`Font fetch HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then(buf => {
        // Chunk-based btoa — avoids call-stack overflow on large buffers
        const bytes = new Uint8Array(buf);
        const CHUNK = 0x8000;
        let binary = '';
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        console.log(`[font] Edge font ready (${(buf.byteLength / 1024).toFixed(0)} KB)`);
        return btoa(binary);
      })
      .catch(e => {
        console.error('[font] Edge font load failed:', e.message);
        _fontBase64Promise = null; // allow retry on next cold start
        return null;
      });
  }
  return _fontBase64Promise;
}

/**
 * Injects an @font-face rule into an SVG so resvg-wasm can find the font
 * when rendering text nodes.
 *
 * Strategy (in order of preference):
 *   1. Prepend to an existing <style> block
 *   2. Insert into existing <defs>
 *   3. Add fresh <defs><style>…</style></defs> right after the opening <svg> tag
 *
 * @param {string}      svgText    Raw SVG markup
 * @param {string|null} fontBase64 TTF data as base64, or null to skip
 * @param {string}      fontFamily CSS font-family name to register
 * @returns {string} SVG with font embedded (or unchanged if fontBase64 is null)
 */
// core/font.js
export function injectFontIntoSvg(svgText, fontBase64, fontFamily = EDGE_FONT_FAMILY) {
  if (!fontBase64) return svgText;

  // Added global CSS selectors for standard bold font weights
  const fontFace =
    `@font-face{font-family:'${fontFamily}';` +
    `src:url('data:font/ttf;base64,${fontBase64}') format('truetype');} ` +
    `text[font-weight="bold"], text[font-weight="bolder"], text[font-weight="600"], text[font-weight="700"], text[font-weight="800"], text[font-weight="900"] { ` +
    `stroke: currentColor; stroke-width: 1.5px; stroke-linejoin: round; }`;

  if (svgText.includes('<style>')) {
    return svgText.replace('<style>', `<style>${fontFace}`);
  }
  if (svgText.includes('<defs>')) {
    return svgText.replace('<defs>', `<defs><style>${fontFace}</style>`);
  }
  return svgText.replace(/(<svg[^>]*>)/, `$1<defs><style>${fontFace}</style></defs>`);
}