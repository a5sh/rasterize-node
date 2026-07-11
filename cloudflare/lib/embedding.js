// cloudflare/lib/embedding.js
//
// Single-poster embedding for Worker B, CF-cache-backed for 5 minutes
// (keyed by poster URL + a hash of the SVG's first 4096 chars + last 64
// chars, which captures layout including badge positions and title content
// — not just the <defs> prefix — so requests that only differ in
// title/badge params get distinct cache entries).
//
// Embed-outcome analytics datapoint (RASTER_METRICS, blob1 = 'embed'):
//   blob5 = outcome  'success' | 'failure'
//   blob6 = errorReason  '' on success, 'http_NNN' | 'throw:...' on failure
//   double1 = embedMs

function hashStr(str) {
  let h = 0x811c9dc5;
  const len = Math.min(str.length, 4096);
  for (let i = 0; i < len; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Mix in the last 64 chars so SVGs with shared <defs> prefixes but different
  // badge/title content downstream produce distinct keys.
  const tail = str.length > 4096 ? str.slice(-64) : "";
  for (let i = 0; i < tail.length; i++) {
    h ^= tail.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
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

function logEmbedOutcome(env, { ok, embedMs, reason }) {
  try {
    env?.RASTER_METRICS?.writeDataPoint({
      blobs: [
        "embed",
        "",
        "",
        "",
        ok ? "success" : "failure",
        reason,
        "embed",
        "",
      ],
      doubles: [embedMs, ok ? 200 : 0, 0, 0, 0],
      indexes: ["embed"],
    });
  } catch (_) {}
}

/**
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

  const cacheKey = `poster-embed:${hashStr(posterUrl)}:${hashStr(svgText)}`;
  const cacheReq = new Request(`https://embed-cache.internal/${cacheKey}`);
  const cache = caches.default;

  try {
    const hit = await cache.match(cacheReq);
    if (hit) {
      const svg = await hit.text();
      log("debug", "embed_cache_hit", { key: cacheKey.slice(0, 40) });
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
      logEmbedOutcome(env, {
        ok: false,
        embedMs: Date.now() - t0,
        reason: `http_${res.status}`,
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
          },
        }),
      );
    } catch (_) {
      /* non-fatal */
    }

    logEmbedOutcome(env, { ok: true, embedMs: Date.now() - t0, reason: "" });
    return { svg, embedMs: Date.now() - t0, embedded: true };
  } catch (e) {
    log("warn", "poster_embed_failed", {
      reason: e?.message,
      url: posterUrl.slice(0, 100),
    });
    logEmbedOutcome(env, {
      ok: false,
      embedMs: Date.now() - t0,
      reason: `throw:${e?.message?.slice(0, 60) || "unknown"}`,
    });
    return { svg: svgText, embedMs: Date.now() - t0, embedded: false };
  }
}
