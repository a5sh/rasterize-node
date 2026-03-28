import { Resvg }          from "@resvg/resvg-js";
import { writeFileSync, existsSync } from "node:fs";
import { processRequest } from "../../core/logic.js";
// Generated at build time by scripts/embed-font.mjs
import { FONT_BUFFER } from "./font-data.js";

// ── Font setup ────────────────────────────────────────────────────────────────
//
// ROOT CAUSE OF INVISIBLE TEXT:
//   fontBuffers is a @resvg/resvg-wasm option only.
//   @resvg/resvg-js (Node native binding) silently ignores it, so no font was
//   ever loaded and resvg rendered all text as invisible missing-glyph boxes.
//
// FIX: write FONT_BUFFER to /tmp once per cold-start and pass the path via
//   fontFiles — the correct API for the Node native binding.

const FONT_FAMILY    = "Noto Sans";
const FONT_TEMP_PATH = "/tmp/NotoSans-Subset.ttf";
let   fontFileReady  = false;

function ensureFontOnDisk() {
  if (fontFileReady) return true;
  if (!FONT_BUFFER?.length) {
    console.error("[font] FONT_BUFFER is empty — did vercel-build run?");
    return false;
  }
  try {
    if (!existsSync(FONT_TEMP_PATH)) {
      writeFileSync(FONT_TEMP_PATH, FONT_BUFFER);
      console.log(`[font] Written ${FONT_BUFFER.length} B → ${FONT_TEMP_PATH}`);
    }
    fontFileReady = true;
    return true;
  } catch (e) {
    console.error("[font] Could not write font to /tmp:", e.message);
    return false;
  }
}

// Eager: run at module load so the file is ready before the first request.
ensureFontOnDisk();

// ── External image embedding ──────────────────────────────────────────────────

async function embedExternalImages(svgText) {
  const regex   = /href="(https?:\/\/[^"]+)"/g;
  const matches = [...svgText.matchAll(regex)];
  if (!matches.length) return svgText;

  const uniqueUrls = [...new Set(matches.map(m => m[1]))];

  const replacements = await Promise.all(
    uniqueUrls.map(async url => {
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": "SpicyDevs-Rasterizer/2.0" },
          signal:  AbortSignal.timeout(8_000),
        });
        if (!res.ok) return { url, dataUri: null };
        const buf   = await res.arrayBuffer();
        const ct    = res.headers.get("content-type") || "image/jpeg";
        const bytes = new Uint8Array(buf);
        const CHUNK = 0x8000;
        let bin = "";
        for (let i = 0; i < bytes.length; i += CHUNK)
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        return { url, dataUri: `data:${ct};base64,${btoa(bin)}` };
      } catch {
        return { url, dataUri: null };
      }
    }),
  );

  for (const { url, dataUri } of replacements)
    if (dataUri) svgText = svgText.split(`href="${url}"`).join(`href="${dataUri}"`);

  return svgText;
}

// ── CORS ──────────────────────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();

  const getBodyText = async () => {
    let raw;
    if (typeof req.body === "object" && req.body !== null) raw = req.body;
    else if (typeof req.body === "string")                  raw = req.body;
    else if (Buffer.isBuffer(req.body))                     raw = req.body.toString("utf-8");
    else {
      raw = await new Promise((resolve, reject) => {
        let d = "";
        req.on("data",  c => (d += c));
        req.on("end",   () => resolve(d));
        req.on("error", reject);
      });
    }

    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (parsed?.svgText) return parsed.svgText;
      if (parsed?.svgUrl) {
        console.log(`[fallback] fetching SVG from: ${parsed.svgUrl}`);
        const r = await fetch(parsed.svgUrl, {
          headers: { "User-Agent": "Vercel-Rasterizer/2.0" },
        });
        return r.text();
      }
    } catch { /* not JSON */ }

    return typeof raw === "string" ? raw : JSON.stringify(raw);
  };

  let processed;
  try {
    processed = await processRequest(
      `https://${req.headers.host}${req.url}`,
      req.method, req.headers, getBodyText, process.env,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[rasterize] processRequest error:", msg);
    return res.status(500).json({ error: msg });
  }

  if (processed.status !== 200 || !processed.svgText) {
    res.setHeader("Content-Type", processed.contentType || "text/plain");
    return res.status(processed.status).send(processed.body);
  }

  try {
    // Sanitize
    let svgText = processed.svgText.trim();
    if (svgText.charCodeAt(0) === 0xFEFF) svgText = svgText.slice(1);

    // Embed external images so resvg can render them
    svgText = await embedExternalImages(svgText);

    // Normalise font attributes to exactly match the embedded subset.
    // Strip explicit bold/bolder — the subset is single-weight; a weight
    // mismatch causes resvg to skip the file and render text invisibly.
    svgText = svgText
      .replace(/font-weight=(["'])(?:bold|bolder|\d{3,})\1/gi, 'font-weight="normal"')
      .replace(/font-family=(["']).*?\1/gi, `font-family="${FONT_FAMILY}"`);

    const hasFontFile = ensureFontOnDisk();

    const resvg = new Resvg(svgText, {
      fitTo: { mode: "original" },
      font: {
        loadSystemFonts:   false,
        defaultFontFamily: FONT_FAMILY,
        sansSerifFamily:   FONT_FAMILY,
        // ↓ fontFiles is the correct option for @resvg/resvg-js (Node native).
        //   fontBuffers only exists in @resvg/resvg-wasm.
        ...(hasFontFile ? { fontFiles: [FONT_TEMP_PATH] } : {}),
      },
      imageRendering: 0,
    });

    res.setHeader("Content-Type",  "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.status(200).send(Buffer.from(resvg.render().asPng()));

  } catch (e) {
    const msg = e instanceof Error ? e.message
              : typeof e === "string" ? e
              : JSON.stringify(e);
    console.error("[rasterize] render error:", msg, e?.stack ?? "");
    return res.status(500).json({ error: msg });
  }
}