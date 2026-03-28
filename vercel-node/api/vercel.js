import { Resvg } from "@resvg/resvg-js";
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
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

    if (req.method === "OPTIONS") {
        return res.status(204).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        // 1. Safely extract JSON payload
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        let { svgText, svgUrl } = body || {};

        // Fallback fetch: If svgText was stripped due to size limits
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

        // 2. AGGRESSIVE SANITIZATION: Fix the 1:1 error (BOM and Whitespace)
        svgText = svgText.trim();
        if (svgText.charCodeAt(0) === 0xFEFF) {
            svgText = svgText.slice(1);
        }

        // 3. Normalize SVG attributes to perfectly match the embedded Regular TTF
        svgText = svgText
            .replace(/font-weight=(["']).*?\1/gi, 'font-weight="normal"')
            .replace(/font-family=(["']).*?\1/gi, 'font-family="Noto Sans"');

        // 4. Validate XML signature to prevent rust panics
        if (!svgText.startsWith('<svg') && !svgText.startsWith('<?xml')) {
            console.error("[Invalid Payload] First 150 chars:", svgText.substring(0, 150));
            return res.status(400).json({ 
                error: "Payload is not a valid SVG string", 
                preview: svgText.substring(0, 50) 
            });
        }

        // 5. Pre-process SVG: Embed external images securely
        svgText = await embedExternalImages(svgText);

        // 6. Execute Rasterization
        const resvg = new Resvg(svgText, {
            fitTo: { mode: 'original' },
            font: { 
                loadSystemFonts: false,
                defaultFontFamily: 'Noto Sans',
                fontBuffers: [FONT_BUFFER] 
            },
            imageRendering: 1
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