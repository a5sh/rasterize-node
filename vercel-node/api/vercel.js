import { Resvg } from "@resvg/resvg-js";
import { processRequest } from "../../core/logic.js";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Font committed at vercel-node/api/NotoSans-Subset.ttf
// — same directory as this file, no cross-boundary path needed.
const FONT_BUFFER = (() => {
    try {
        return fs.readFileSync(
            fileURLToPath(new URL("./NotoSans-Subset.ttf", import.meta.url))
        );
    } catch (e) {
        console.error("[rasterize] Font load failed:", e.message);
        return null;
    }
})();

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

    const getBodyText = async () => {
        if (typeof req.body === "string") return req.body;
        if (Buffer.isBuffer(req.body)) return req.body.toString("utf-8");
        return new Promise((resolve, reject) => {
            let data = "";
            req.on("data", chunk => (data += chunk));
            req.on("end", () => resolve(data));
            req.on("error", reject);
        });
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
        const svgText = await embedExternalImages(processed.svgText);

        const resvg = new Resvg(svgText, {
            fitTo: { mode: "original" },
            font: {
                loadSystemFonts: false,
                defaultFontFamily: "Noto Sans",
                ...(FONT_BUFFER && { fontBuffers: [new Uint8Array(FONT_BUFFER)] }),
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