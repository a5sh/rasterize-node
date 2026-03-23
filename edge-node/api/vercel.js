import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm?module";
import fontBuffer from "../../core/NotoSans-Subset.ttf?arraybuffer";
import { processRequest } from "../../core/logic.js";

export const config = { runtime: "edge" };

let wasmInitialized = false;

/**
 * Find all external http(s) image hrefs in the SVG, fetch them,
 * and replace with inline base64 data URIs so resvg-wasm can render them.
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

export default async function handler(request) {
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            }
        });
    }

    if (!wasmInitialized) {
        await initWasm(resvgWasm);
        wasmInitialized = true;
    }

    const getBodyText = async () => await request.text();
    const processed = await processRequest(request.url, request.method, request.headers, getBodyText, process.env);

    if (processed.status !== 200 || !processed.svgText) {
        return new Response(processed.body, {
            status: processed.status,
            headers: { "Content-Type": processed.contentType || "text/plain", "Access-Control-Allow-Origin": "*" }
        });
    }

    try {
        // Embed any external image URLs before passing to resvg
        const svgText = await embedExternalImages(processed.svgText);

        const resvgOpts = {
            fitTo: { mode: "original" },
            font: {
                loadSystemFonts: false,
                defaultFontFamily: "Noto Sans",
                fontBuffers: [new Uint8Array(fontBuffer)],
            },
            imageRendering: 1,
        };

        const resvg = new Resvg(svgText, resvgOpts);

        return new Response(resvg.render().asPng(), {
            status: 200,
            headers: {
                "Content-Type": "image/png",
                "Cache-Control": "public, max-age=86400",
                "Access-Control-Allow-Origin": "*"
            }
        });
    } catch (error) {
        const msg = error instanceof Error
            ? error.message
            : (typeof error === "string" ? error : JSON.stringify(error));
        console.error("[rasterize] render error:", msg, error?.stack || "");
        return new Response(JSON.stringify({ error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
    }
}