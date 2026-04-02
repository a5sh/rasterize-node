// core/sharedRender.js
//
// Shared font resolution + resvg options for every Node.js rasterizer
// (netlify, vercel, render, vps).  Cloudflare uses fontBuffers directly
// in worker.js and does not use this module.
//
// FONT STRATEGY
// ─────────────
// All platforms ship NotoSans-Subset.ttf (Regular only).
// Bold is synthesised by applyFauxBold() before every render call —
// NOT by loading a bold font variant.  This guarantees pixel-identical
// output across the whole fleet.
//
// This file is copied to {platform}/lib/ by scripts/build.mjs at deploy time.
// NotoSans-Subset.ttf is copied alongside it so the path.join(_moduleDir, …)
// reference resolves correctly in both local dev and production bundles.
//
// NOTE: We intentionally avoid declaring __dirname here because Lambda/NFT
// environments inject it as a global in CJS bundles, causing a redeclaration
// SyntaxError at runtime.

import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Use a non-conflicting name so this module is safe in both ESM and
// NFT-bundled CJS Lambda contexts where __dirname is already a global.
const _moduleDir = path.dirname(fileURLToPath(import.meta.url));

// Resolved once at module load; null if the font file is missing.
const FONT_SRC = (() => {
  const p = path.join(_moduleDir, 'NotoSans-Subset.ttf');
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return p;
  } catch {
    console.error('[sharedRender] NotoSans-Subset.ttf not found next to sharedRender.js');
    return null;
  }
})();

let _tmpFontPath = null;

/**
 * Copies the bundled TTF to /tmp on first call and returns the path.
 * resvg-js on some platforms can't read files outside /tmp from a lambda
 * context, so we always stage through /tmp.
 *
 * Returns null if the font is unavailable (resvg will still run, text just
 * falls back to an internal sans-serif).
 *
 * @returns {string|null}
 */
export function getFontPath() {
  if (_tmpFontPath) return _tmpFontPath;
  if (!FONT_SRC)    return null;

  const dst = path.join(os.tmpdir(), 'NotoSans-Subset.ttf');
  try {
    // Skip write if already there and non-empty (warm lambda / warm container).
    const stat = fs.existsSync(dst) && fs.statSync(dst);
    if (!stat || stat.size === 0) {
      fs.writeFileSync(dst, fs.readFileSync(FONT_SRC));
    }
    _tmpFontPath = dst;
    console.log(`[font] NotoSans-Subset staged → ${dst}`);
  } catch (e) {
    // /tmp write failed (rare) — fall back to reading from source path directly.
    console.warn(`[font] /tmp write failed (${e.message}), using source path`);
    _tmpFontPath = FONT_SRC;
  }
  return _tmpFontPath;
}

/**
 * Returns a resvg-js options object configured for the bundled subset font.
 *
 * loadSystemFonts is always false — system bold variants must NOT be loaded
 * or they will produce heavier output than the faux-bold synthesis on other nodes.
 *
 * @returns {object}
 */
export function buildResvgOpts() {
  const fontPath = getFontPath();
  const fontConf = {
    loadSystemFonts:   false,
    defaultFontFamily: 'Noto Sans',
    sansSerifFamily:   'Noto Sans',
    serifFamily:       'Noto Sans',
    monospaceFamily:   'Noto Sans',
  };
  if (fontPath) fontConf.fontFiles = [fontPath];

  return {
    fitTo:          { mode: 'original' },
    imageRendering: 0,
    font:           fontConf,
  };
}