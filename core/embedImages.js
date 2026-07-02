// core/embedImages.js
//
// Shared utility: embed external href URLs in SVG as base64 data URIs.
// Used by all Node.js rasterizer platforms before handing SVG to resvg.
// Worker threads / lambda functions cannot reliably reach external URLs, so
// the main-process server or lambda handler embeds poster hrefs here first.
// Copied to {platform}/lib/ by scripts/build.mjs.

const EXTERNAL_IMG_RE = /href="(https?:\/\/[^"]+)"/g;
const FETCH_TIMEOUT_MS = 8_000;

/**
 * Replace all external http(s) href attributes in an SVG string with
 * inline base64 data URIs. Runs concurrently; failures leave the original
 * URL in place (resvg silently skips unresolvable hrefs).
 *
 * @param {string} svgText
 * @param {string} [userAgent]
 * @returns {Promise<string>}
 */
export async function embedExternalImages(
  svgText,
  userAgent = "SpicyDevs-Rasterizer/1.0",
) {
  const matches = [...svgText.matchAll(EXTERNAL_IMG_RE)];
  if (matches.length === 0) return svgText;

  const uniqueUrls = [...new Set(matches.map((m) => m[1]))];

  const replacements = await Promise.all(
    uniqueUrls.map(async (url) => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          signal: ac.signal,
          headers: { "User-Agent": userAgent },
        });
        clearTimeout(t);
        if (!res.ok) return { url, dataUri: null };
        const buf = Buffer.from(await res.arrayBuffer());
        const ct = res.headers.get("content-type") || "image/jpeg";
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
