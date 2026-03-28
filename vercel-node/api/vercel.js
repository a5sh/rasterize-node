import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { processRequest } from "../../core/logic.js";
import { FONT_BUFFER } from "./font-data.js";

/**
 * Find all external http(s) image hrefs in the SVG, fetch them,
 * and replace with inline base64 data URIs so resvg-js can render them.
 */
async function embedExternalImages(svgText) {
    const regex = /href="(https?:\/\/[^"]+)"/g;
    const matches = [...svgText.matchAll(regex)];
    if (matches.length === 0) return svgText;

    const uniqueUrls = [...new Set(matches.map(m => m[1]))];

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
        })
    );

    for (const { url, dataUri } of replacements) {
        if (!dataUri) continue;
        svgText = svgText.split(`href="${url}"`).join(`href="${dataUri}"`);
    }

    return svgText;
}

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // 1. Safely parse the body regardless of Vercel's auto-parsing behavior
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    let { svgText, svgUrl } = body || {};

    // 2. Fallback fetch: If svgText was stripped due to size limits, fetch it directly
    if (!svgText && svgUrl) {
      console.log(`[Fetch Fallback] Missing svgText, fetching from: ${svgUrl}`);
      const fetchRes = await fetch(svgUrl, {
        headers: { 'User-Agent': 'Vercel-Rasterizer/1.0' }
      });
      svgText = await fetchRes.text();
    }

    if (!svgText || typeof svgText !== 'string') {
      return res.status(400).json({ error: "Missing or invalid svgText payload" });
    }

    // 3. AGGRESSIVE SANITIZATION (Fixes the 1:1 error)
    svgText = svgText.trim(); 
    if (svgText.charCodeAt(0) === 0xFEFF) {
      svgText = svgText.slice(1); 
    }

    // 4. Validate XML signature
    if (!svgText.startsWith('<svg') && !svgText.startsWith('<?xml')) {
      return res.status(400).json({ 
        error: "Payload is not a valid SVG string", 
        preview: svgText.substring(0, 50) 
      });
    }

    // 5. Pre-process SVG: Embed external images as Base64 so Resvg can see them
    svgText = await embedExternalImages(svgText);

    // 6. Execute Rasterization with exact Font Mapping
    const resvg = new Resvg(svgText, {
      font: { 
        loadSystemFonts: false,
        fontBuffers: [FONT_BUFFER],
        defaultFontFamily: 'Noto Sans' // Critical: Forces standard text nodes to use your buffer
      },
      fitTo: { mode: 'original' }
    });

    const image = resvg.render();
    const buffer = image.asPng();

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.status(200).send(buffer);

  } catch (error) {
    console.error("[Rasterize Error]", error.message, error.stack);
    return res.status(500).json({ error: error.message });
  }
}