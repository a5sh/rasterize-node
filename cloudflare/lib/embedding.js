// cloudflare/lib/embedding.js
//
// Single-poster embedding for Worker B, CF-cache-backed.
//
// CACHE MODEL: the cache stores ONLY the encoded poster asset (a base64 data
// URI), keyed 1:1 on the poster URL's SHA-256. The composed SVG is NEVER
// cached here: the expensive work (fetching the poster bytes + base64-encoding
// them) depends only on posterUrl, so every badge-config variant of the same
// movie must share one cache entry. The old scheme hashed posterUrl + the full
// SVG string, so every distinct ?r=/layout/scale variant busted the cache and
// re-fetched + re-encoded the same poster — that duplicated the poster fetch
// and base64 work per request, which was the dominant CPU cost on Worker B.
//
// DO NOT key this cache on SVG content again. If a future refactor needs a
// per-SVG cache, layer it on top of this asset cache, never replace it.
//
// Splice step runs fresh on every request: href="posterUrl" → href="dataUri".
// This is a cheap string replace relative to fetch+encode+hash, and it means
// per-request SVG content is always current without any cache invalidation.
//
// Cache entries carry an X-Embed-Url-Hash header; a hit is only served when
// it matches the current posterUrl's hash (sanity guard on top of the 1:1 key,
// and old-format entries are re-embedded once).
//
// Embed analytics datapoint (RASTER_METRICS, blob1 = 'embed'):
//   blob5 = outcome     'success' | 'failure'
//   blob6 = errorReason '' on success, 'http_NNN' | 'throw:...' on failure
//   blob7 = cache       'hit' | 'miss'
//   double1 = embedMs   wall time for fetch + base64 + splice (0 on cache hit)
//   double2 = gzipMs    wall time spent gzipping the embedded SVG
//   double3 = payloadBytes  embedded SVG length in bytes

async function sha256Hex(str) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(str),
  );
  const bytes = new Uint8Array(digest);
  if (typeof bytes.toHex === "function") return bytes.toHex();
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function bufToB64(buffer) {
  const bytes = new Uint8Array(buffer);
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  let bin = "";
  for (let i = 0; i < bytes.length; i += 32_768)
    bin += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + 32_768, bytes.length)),
    );
  return btoa(bin);
}

/**
 * Fetch the poster image ONCE (per URL) and embed it as a base64 data URI,
 * replacing every href="posterUrl" occurrence in the SVG. The cache holds
 * only the encoded poster asset, keyed on posterUrl — never the composed SVG.
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

  const urlHash = await sha256Hex(posterUrl);
  const cacheKey = `poster-asset:${urlHash}`;
  const cacheReq = new Request(`https://embed-cache.internal/${cacheKey}`);
  const cache = caches.default;

  const asset = await fetchPosterAsset(cache, cacheReq, urlHash, posterUrl, posterEmbedTimeoutMs, log);

  if (!asset) {
    return { svg: svgText, embedMs: asset?.embedMs ?? 0, embedded: false };
  }

  const svg = svgText.split(`href="${posterUrl}"`).join(`href="${asset.dataUri}"`);
  return {
    svg,
    embedMs: asset.embedMs,
    embedded: true,
    fromCache: asset.fromCache,
  };
}

/**
 * Get-or-fetch the base64 data URI for a poster URL.
 *
 * @returns {Promise<{dataUri: string, embedMs: number, fromCache: boolean} | null>}
 */
async function fetchPosterAsset(cache, cacheReq, urlHash, posterUrl, posterEmbedTimeoutMs, log) {
  try {
    const hit = await cache.match(cacheReq);
    // Sanity guard on top of the key: only serve the hit when it was written
    // for THIS poster URL. Old-format entries are re-embedded once.
    if (hit && hit.headers.get("x-embed-url-hash") === urlHash) {
      const dataUri = await hit.text();
      if (dataUri) {
        return { dataUri, embedMs: 0, fromCache: true };
      }
    }
  } catch (_) {
    /* cache read failure — proceed to fetch */
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
      return null;
    }
    const buf = await res.arrayBuffer();
    const ct = res.headers.get("content-type") || "image/jpeg";
    const dataUri = `data:${ct};base64,${bufToB64(buf)}`;
    const embedMs = Date.now() - t0;

    try {
      await cache.put(
        cacheReq,
        new Response(dataUri, {
          headers: {
            "Content-Type": "text/plain",
            "Cache-Control": "public, max-age=1800",
            "X-Embed-Url-Hash": urlHash,
          },
        }),
      );
    } catch (_) {
      /* non-fatal */
    }

    return { dataUri, embedMs, fromCache: false };
  } catch (e) {
    log("warn", "poster_embed_failed", {
      reason: e?.message,
      url: posterUrl.slice(0, 100),
    });
    return null;
  }
}
