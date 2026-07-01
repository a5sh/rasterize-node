// core/renderWorker.js

import { createRequire } from "node:module";
import { workerData, parentPort } from "node:worker_threads";
import { applyFauxBold } from "./fauxBold.js";
import { getCachedPoster, setCachedPoster } from "./cache.js";

const _require = createRequire(workerData.serverDir + "/_.js");
const { Resvg } = _require("@resvg/resvg-js");

// ── CRYPTO-FREE cache key ─────────────────────────────────────────────────────
// Do NOT import createHash from node:crypto here.  On Render.com (and NFT-
// bundled envs) it can resolve to the Web Crypto API which has no createHash().
// A simple inline FNV-1a hash is entirely sufficient for a render-cache key.
function simpleHash(str) {
  let h = 0x811c9dc5;
  // Only hash the first 4 KB — SVGs are large but the meaningful variance is
  // in the first few hundred bytes (dimensions, viewBox, first elements).
  const len = Math.min(str.length, 4096);
  for (let i = 0; i < len; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Also mix the tail (last 64 chars) to distinguish SVGs with shared prefixes
  const tail = str.length > 4096 ? str.slice(-64) : "";
  for (let i = 0; i < tail.length; i++) {
    h ^= tail.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const OPTS = workerData.resvgOpts;

// ── Pre-warm ──────────────────────────────────────────────────────────────────

// AFTER
const WARMUP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750" viewBox="0 0 500 750">
  <rect width="500" height="750" fill="#1a1a1a"/>
  <rect x="30" y="30" width="140" height="60" rx="12" fill="rgba(0,0,0,0.45)"/>
  <text x="100" y="30" dy="0.35em" text-anchor="middle"
        font-family="Noto Sans,Arial,sans-serif" font-size="28"
        font-weight="bold" fill="#ffffff">8.5</text>
</svg>`;

try {
  new Resvg(applyFauxBold(WARMUP_SVG), OPTS).render().asPng();
} catch (e) {
  console.warn("[worker] Pre-warm failed (non-fatal):", e.message);
}

// ── External image embedding ──────────────────────────────────────────────────

const EXTERNAL_IMG_RE = /href="(https?:\/\/[^"]+)"/g;
const FETCH_TIMEOUT_MS = 6_000;

async function embedExternalImages(svgText) {
  const matches = [...svgText.matchAll(EXTERNAL_IMG_RE)];
  if (matches.length === 0) return svgText;

  const uniqueUrls = [...new Set(matches.map((m) => m[1]))];

  const replacements = await Promise.all(
    uniqueUrls.map(async (url) => {
      const cached = getCachedPoster(url);
      if (cached) {
        return {
          url,
          dataUri: `data:${cached.ct};base64,${cached.data.toString("base64")}`,
        };
      }
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          signal: ac.signal,
          headers: { "User-Agent": "SpicyDevs-Rasterizer/4.0" },
        });
        clearTimeout(t);
        if (!res.ok) return { url, dataUri: null };
        const buf = Buffer.from(await res.arrayBuffer());
        const ct = res.headers.get("content-type") || "image/jpeg";
        setCachedPoster(url, buf, ct);
        return { url, dataUri: `data:${ct};base64,${buf.toString("base64")}` };
      } catch {
        clearTimeout(t);
        return { url, dataUri: null };
      }
    }),
  );

  for (const { url, dataUri } of replacements) {
    if (dataUri)
      svgText = svgText.split(`href="${url}"`).join(`href="${dataUri}"`);
  }
  return svgText;
}

// ── Message handler ───────────────────────────────────────────────────────────

const _renderCache = new Map();
const RENDER_CACHE_TTL = 3 * 60_000;
const MAX_RENDER_CACHE = 50;

parentPort.on("message", async ({ jobId, svgText, format }) => {
  try {
    const cacheKey = simpleHash(svgText) + ":" + format;
    const cached = _renderCache.get(cacheKey);

    if (cached && Date.now() < cached.expiry) {
      const ab = cached.png.buffer.slice(
        cached.png.byteOffset,
        cached.png.byteOffset + cached.png.byteLength,
      );
      parentPort.postMessage({ jobId, buffer: ab, mimeType: cached.mime }, [
        ab,
      ]);
      return;
    }

    const embedded = await embedExternalImages(svgText);
    const processed = applyFauxBold(embedded);
    const resvg = new Resvg(processed, OPTS);
    const rendered = resvg.render();

    let buf, mime;
    if (
      (format === "jpg" || format === "jpeg") &&
      typeof rendered.asJpeg === "function"
    ) {
      buf = rendered.asJpeg(85);
      mime = "image/jpeg";
    } else if (format === "webp" && typeof rendered.asWebp === "function") {
      buf = rendered.asWebp(85);
      mime = "image/webp";
    } else {
      buf = rendered.asPng();
      mime = "image/png";
    }

    if (_renderCache.size >= MAX_RENDER_CACHE) {
      _renderCache.delete(_renderCache.keys().next().value);
    }
    _renderCache.set(cacheKey, {
      png: buf,
      mime,
      expiry: Date.now() + RENDER_CACHE_TTL,
    });

    const ab = buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    );
    parentPort.postMessage({ jobId, buffer: ab, mimeType: mime }, [ab]);
  } catch (err) {
    parentPort.postMessage({ jobId, error: err.message });
  }
});
