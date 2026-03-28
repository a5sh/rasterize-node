import { Resvg } from "@resvg/resvg-js";
import { processRequest } from "../../core/logic.js";

// ── Font loading ──────────────────────────────────────────────────────────────
//
// Vercel Lambda runs on Amazon Linux which has no guaranteed system fonts.
// We download NotoSans-Regular once per cold start and cache the Buffer so
// every subsequent invocation in the same Lambda instance is instant.
//
// This replaces the previous build-time embed approach (embed-font.mjs /
// font-data.js) which broke silently when core/NotoSans-Subset.ttf was
// absent from the repo.

const FONT_TTF_URL =
  "https://github.com/notofonts/notofonts.github.io/raw/main/fonts/NotoSans/hinted/ttf/NotoSans-Regular.ttf";

const FONT_FAMILY = "Noto Sans";

/** @type {Promise<Buffer|null>} — resolved once per cold start */
let _fontPromise = null;

function loadFont() {
  if (_fontPromise) return _fontPromise;
  _fontPromise = fetch(FONT_TTF_URL, { signal: AbortSignal.timeout(20_000) })
    .then((r) => {
      if (!r.ok) throw new Error(`Font fetch HTTP ${r.status}`);
      return r.arrayBuffer();
    })
    .then((buf) => {
      const buffer = Buffer.from(buf);
      console.log(`[font] NotoSans ready (${(buffer.length / 1024).toFixed(0)} KB)`);
      return buffer;
    })
    .catch((e) => {
      console.error("[font] Font load failed:", e.message);
      _fontPromise = null; // allow retry on next cold start
      return null;
    });
  return _fontPromise;
}

// Kick off the download immediately at module load so it's ready (or nearly
// ready) by the time the first real request arrives.
loadFont();

// ── External image embedding ──────────────────────────────────────────────────

async function embedExternalImages(svgText) {
  const regex = /href="(https?:\/\/[^"]+)"/g;
  const matches = [...svgText.matchAll(regex)];
  if (matches.length === 0) return svgText;

  const uniqueUrls = [...new Set(matches.map((m) => m[1]))];

  const replacements = await Promise.all(
    uniqueUrls.map(async (url) => {
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": "SpicyDevs-Rasterizer/2.0" },
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) return { url, dataUri: null };
        const buf = await res.arrayBuffer();
        const ct = res.headers.get("content-type") || "image/jpeg";
        const bytes = new Uint8Array(buf);
        const CHUNK = 0x8000;
        let binary = "";
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return { url, dataUri: `data:${ct};base64,${btoa(binary)}` };
      } catch {
        return { url, dataUri: null };
      }
    }),
  );

  for (const { url, dataUri } of replacements) {
    if (!dataUri) continue;
    svgText = svgText.split(`href="${url}"`).join(`href="${dataUri}"`);
  }

  return svgText;
}

// ── CORS ──────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // ── Body reader ────────────────────────────────────────────────────────────
  const getBodyText = async () => {
    let rawData;

    if (typeof req.body === "object" && req.body !== null) {
      rawData = req.body;
    } else if (typeof req.body === "string") {
      rawData = req.body;
    } else if (Buffer.isBuffer(req.body)) {
      rawData = req.body.toString("utf-8");
    } else {
      rawData = await new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
        req.on("error", reject);
      });
    }

    try {
      const parsed = typeof rawData === "string" ? JSON.parse(rawData) : rawData;

      if (parsed && parsed.svgText) {
        return parsed.svgText;
      }
      if (parsed && parsed.svgUrl) {
        console.log(`[Fetch Fallback] Missing svgText, fetching from: ${parsed.svgUrl}`);
        const fetchRes = await fetch(parsed.svgUrl, {
          headers: { "User-Agent": "Vercel-Rasterizer/2.0" },
        });
        return await fetchRes.text();
      }
    } catch {
      // Not JSON — fall through
    }

    return typeof rawData === "string" ? rawData : JSON.stringify(rawData);
  };

  // ── Route through shared logic ─────────────────────────────────────────────
  let processed;
  try {
    processed = await processRequest(
      `https://${req.headers.host}${req.url}`,
      req.method,
      req.headers,
      getBodyText,
      process.env,
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[rasterize] processRequest error:", msg);
    return res.status(500).json({ error: msg });
  }

  if (processed.status !== 200 || !processed.svgText) {
    res.setHeader("Content-Type", processed.contentType || "text/plain");
    return res.status(processed.status).send(processed.body);
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  try {
    // Sanitize
    let svgText = processed.svgText.trim();
    if (svgText.charCodeAt(0) === 0xfeff) svgText = svgText.slice(1);

    // Embed external images so resvg can render them
    svgText = await embedExternalImages(svgText);

    // Await the font (already in-flight from module load; usually instant)
    const fontBuffer = await loadFont();

    if (!fontBuffer) {
      // No font available — log and proceed; resvg may still render with
      // loadSystemFonts:true as a last-ditch fallback on the Lambda host.
      console.warn("[rasterize] Rendering without embedded font — text may be invisible");
    }

    // Force all text to use the loaded font family
    svgText = svgText
      .replace(/font-weight=(["'])(?:bold|bolder|\d+)\1/gi, 'font-weight="normal"')
      .replace(/font-family=(["']).*?\1/gi, `font-family="${FONT_FAMILY}"`);

    const resvgOpts = {
      fitTo: { mode: "original" },
      font: {
        // Load system fonts as last resort; our buffer takes priority when present
        loadSystemFonts: !fontBuffer,
        defaultFontFamily: FONT_FAMILY,
        sansSerifFamily: FONT_FAMILY,
        ...(fontBuffer ? { fontBuffers: [fontBuffer] } : {}),
      },
      imageRendering: 0,
    };

    const resvg = new Resvg(svgText, resvgOpts);
    const png = Buffer.from(resvg.render().asPng());

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.status(200).send(png);
  } catch (error) {
    const msg =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : JSON.stringify(error);
    console.error("[rasterize] render error:", msg, error?.stack || "");
    return res.status(500).json({ error: msg });
  }
}