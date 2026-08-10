// cloudflare/lib/embedding.js
//
// Single-poster embedding for Worker B, CF-cache-backed for 5 minutes.
//
// The cache key hashes the ENTIRE posterUrl and the ENTIRE svgText with
// SHA-256 (previously the SVG hash only covered the first 4096 chars + last
// 64, which collapsed towards a single value once icon <symbol> defs pushed
// the poster href / title / badge values past the 4096-char window — that
// made concurrent requests for different movies share cache entries).
//
// Cache hits are additionally verified: every entry is written with an
// X-Embed-Url-Hash header, and a hit is only served when that header matches
// the current posterUrl's hash. Entries without the header (old format) are
// treated as misses and re-embedded once.
//
// Embed-outcome analytics datapoint (RASTER_METRICS, blob1 = 'embed'):
//   blob5 = outcome  'success' | 'failure'
//   blob6 = errorReason  '' on success, 'http_NNN' | 'throw:...' on failure
//   double1 = embedMs

async function sha256Hex(str) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(str),
  );
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function bufToB64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 32_768)
    bin += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + 32_768, bytes.length)),
    );
  return btoa(bin);
}

/**
 * Embed outcome no longer writes a RASTER_METRICS row — that was ~1
 * datapoint per request ("embed"-tagged), redundant with the per-attempt
 * rows and Worker A's per-request wall-time row. Errors still surface via
 * the warn-level logs below; cache-readiness is visible from the serverless
 * /health iconCache fields.
 *
 * Fetch the poster image ONCE and embed it as a base64 data URI, replacing
 * every href="posterUrl" occurrence in the SVG.
 *
 * @param {string} svgText
 * @param {string|null} posterUrl
 * @param {object} env
 * @param {number} posterEmbedTimeoutMs
 * @param {function} log - structured logger: (level, event, meta) => void
 * @returns {Promise<{svg:string, embedMs:number, embedded:boolean, fromCache?:boolean}>}
 */
export async function embedPoster(
  svgText,
  posterUrl,
  env,
  posterEmbedTimeoutMs,
  log,
) {
  if (!posterUrl) return { svg: svgText, embedMs: 0, embedded: false };

  // Full-string SHA-256 of BOTH inputs — no truncation windows, so posters
  // that differ anywhere (href, title, badge values, layout) get distinct
  // keys even when their shared <defs>/icon boilerplate dwarfs the rest.
  const [urlHash, svgHash] = await Promise.all([
    sha256Hex(posterUrl),
    sha256Hex(svgText),
  ]);
  const cacheKey = `poster-embed:${urlHash}:${svgHash}`;
  const cacheReq = new Request(`https://embed-cache.internal/${cacheKey}`);
  const cache = caches.default;

  try {
    const hit = await cache.match(cacheReq);
    // Sanity guard on top of the key: only serve the hit when it was written
    // for THIS poster URL. Old entries (no header) are re-embedded once.
    if (hit && hit.headers.get("x-embed-url-hash") === urlHash) {
      const svg = await hit.text();
      return { svg, embedMs: 0, embedded: true, fromCache: true };
    }
  } catch (_) {
    /* cache miss on error is fine */
  }

  const t0 = Date.now();
  try {
    const res = await fetch(posterUrl, {
      signal: AbortSignal.timeout(posterEmbedTimeoutMs),
      headers: { "User-Agent": "SpicyDevs-LB/13.0", Accept: "image/*" },
      cf: { cacheTtl: 86_400, cacheEverything: true },
    });
    if (!res.ok) {
      log("warn", "poster_embed_http_err", {
        status: res.status,
        url: posterUrl.slice(0, 100),
      });
      return { svg: svgText, embedMs: Date.now() - t0, embedded: false };
    }
    const buf = await res.arrayBuffer();
    const ct = res.headers.get("content-type") || "image/jpeg";
    const uri = `data:${ct};base64,${bufToB64(buf)}`;
    const svg = svgText.split(`href="${posterUrl}"`).join(`href="${uri}"`);

    try {
      await cache.put(
        cacheReq,
        new Response(svg, {
          headers: {
            "Content-Type": "image/svg+xml",
            "Cache-Control": "public, max-age=300",
            "X-Embed-Url-Hash": urlHash,
          },
        }),
      );
    } catch (_) {
      /* non-fatal */
    }

    return { svg, embedMs: Date.now() - t0, embedded: true };
  } catch (e) {
    log("warn", "poster_embed_failed", {
      reason: e?.message,
      url: posterUrl.slice(0, 100),
    });
    return { svg: svgText, embedMs: Date.now() - t0, embedded: false };
  }
}
