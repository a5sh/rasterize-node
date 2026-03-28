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
    // 1. Safely handle Vercel's auto-parsed body vs raw string body
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    let { svgUrl, svgText, format } = body;

    // 2. Validate svgText presence and type
    if (!svgText || typeof svgText !== 'string') {
      console.error("[Validation Error] Missing or invalid svgText in payload.", {
        receivedType: typeof svgText,
        bodyKeys: Object.keys(body)
      });
      return res.status(400).json({ error: "Missing or invalid 'svgText' payload" });
    }

    // 3. Strip leading whitespace/BOM and validate SVG signature
    svgText = svgText.trim();
    if (!svgText.startsWith('<svg') && !svgText.startsWith('<?xml')) {
      console.error("[Validation Error] svgText does not begin with valid SVG tags.", {
        startOfPayload: svgText.substring(0, 50)
      });
      return res.status(400).json({ error: "Payload is not a valid SVG string" });
    }

    // 4. Safe execution
    const resvg = new Resvg(svgText, {
      font: { loadSystemFonts: false },
      fitTo: { mode: 'original' }
    });
    
    const image = resvg.render();
    const buffer = image.asPng(); // Or handle target format dynamically

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.status(200).send(buffer);

  } catch (error) {
    console.error("[Rasterization Error]", error.message, error.stack);
    return res.status(500).json({ error: "Internal Server Error during rasterization" });
  }
}