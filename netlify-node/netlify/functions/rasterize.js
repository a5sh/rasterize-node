import { Resvg } from "@resvg/resvg-js";
import { processRequest } from "../../../core/logic.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load font once at cold-start — Lambda has a real filesystem
const FONT_BUFFER = (() => {
    try {
        return fs.readFileSync(path.join(__dirname, "../../../core/NotoSans-Subset.ttf"));
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

    // Deduplicate URLs
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
                // Chunk-based btoa to avoid stack overflow on large images
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
        // Replace all occurrences of this URL in the SVG
        svgText = svgText.split(`href="${url}"`).join(`href="${dataUri}"`);
    }

    return svgText;
}

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

export const handler = async (event, context) => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 204, headers: CORS_HEADERS, body: "" };
    }

    // Reconstruct a URL + normalise body for processRequest
    const reqUrl = `https://${event.headers.host}${event.path}${
        event.rawQuery ? "?" + event.rawQuery : ""
    }`;
    const bodyText = event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf-8")
        : event.body || "";

    const getBodyText = async () => bodyText;

    let processed;
    try {
        processed = await processRequest(
            reqUrl,
            event.httpMethod,
            event.headers,
            getBodyText,
            process.env
        );
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error("[rasterize] processRequest error:", msg);
        return {
            statusCode: 500,
            headers: { "Content-Type": "application/json", ...CORS_HEADERS },
            body: JSON.stringify({ error: msg }),
        };
    }

    if (processed.status !== 200 || !processed.svgText) {
        return {
            statusCode: processed.status,
            headers: { "Content-Type": processed.contentType || "text/plain", ...CORS_HEADERS },
            body: processed.body,
        };
    }

    try {
        // Embed any external image URLs before passing to resvg
        const svgText = await embedExternalImages(processed.svgText);

        const resvgOpts = {
            fitTo: { mode: "original" },
            font: {
                loadSystemFonts: false,
                defaultFontFamily: "Noto Sans",
                ...(FONT_BUFFER && { fontBuffers: [new Uint8Array(FONT_BUFFER)] }),
            },
            imageRendering: 1,
        };

        const resvg = new Resvg(svgText, resvgOpts);
        const pngBuffer = resvg.render().asPng();

        return {
            statusCode: 200,
            headers: {
                "Content-Type": "image/png",
                "Cache-Control": "public, max-age=86400",
                ...CORS_HEADERS,
            },
            body: Buffer.from(pngBuffer).toString("base64"),
            isBase64Encoded: true,
        };
    } catch (error) {
        const msg = error instanceof Error
            ? error.message
            : (typeof error === "string" ? error : JSON.stringify(error));
        console.error("[rasterize] render error:", msg, error?.stack || "");
        return {
            statusCode: 500,
            headers: { "Content-Type": "application/json", ...CORS_HEADERS },
            body: JSON.stringify({ error: msg }),
        };
    }
};