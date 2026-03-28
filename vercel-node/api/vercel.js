import { Resvg } from "@resvg/resvg-js";
import { processRequest } from "../../core/logic.js";
// Generated at build time by scripts/embed-font.mjs — always present, no fs I/O needed
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

    // Safely extract svgText from the JSON body (or fetch from svgUrl if missing)
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
                req.on("data", chunk => (data += chunk));
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
                const fetchRes = await fetch(parsed.svgUrl, { headers: { 'User-Agent': 'Vercel-Rasterizer/1.0' } });
                return await fetchRes.text();
            }
        } catch (e) {
            // Not JSON, continue to return rawData below
        }
        
        return typeof rawData === "string" ? rawData : JSON.stringify(rawData);
    };

    let processed;
    try {
        processed = await processRequest(
            `https://${req.headers.host}${req.url}`,
            req.method,
            req.headers,
            getBodyText,
            process.env
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

    try {
        let svgText = processed.svgText;

        // AGGRESSIVE SANITIZATION: Prevents the Resvg 1:1 error crash
        svgText = svgText.trim();
        if (svgText.charCodeAt(0) === 0xFEFF) {
            svgText = svgText.slice(1);
        }

        svgText = await embedExternalImages(svgText);

        // Normalize SVG attributes to perfectly match the embedded Regular TTF
        // Strips any bold/bolder requests and forces the exact font family name
        svgText = svgText
            .replace(/font-weight=(["']).*?\1/gi, 'font-weight="normal"')
            .replace(/font-family=(["']).*?\1/gi, 'font-family="Noto Sans"');

        const resvg = new Resvg(svgText, {
            fitTo: { mode: "original" },
            font: {
                loadSystemFonts: true,
                defaultFontFamily: "Noto Sans",
                fontBuffers: [FONT_BUFFER], // Keep as a Node Buffer
            },
            imageRendering: 1,
        });

        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "public, max-age=86400");
        return res.status(200).send(Buffer.from(resvg.render().asPng()));
    } catch (error) {
        const msg = error instanceof Error
            ? error.message
            : (typeof error === "string" ? error : JSON.stringify(error));
        console.error("[rasterize] render error:", msg, error?.stack || "");
        return res.status(500).json({ error: msg });
    }
}