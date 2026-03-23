import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import { processRequest } from "../core/logic.js";
import { loadEdgeFont, injectFontIntoSvg, EDGE_FONT_FAMILY } from "../core/font.js";

let wasmInitialized = false;
let fontBase64Promise = null;

export default {
    async fetch(request, env, ctx) {
        // Kick off font fetch in parallel with WASM init on first request
        if (!wasmInitialized) {
            await initWasm(resvgWasm);
            wasmInitialized = true;
        }
        if (!fontBase64Promise) {
            fontBase64Promise = loadEdgeFont();
        }

        const getBodyText = async () => await request.text();
        const processed = await processRequest(request.url, request.method, request.headers, getBodyText, env);

        if (processed.status !== 200 || !processed.svgText) {
            return new Response(processed.body, { 
                status: processed.status,
                headers: { "Content-Type": processed.contentType || "text/plain", "Access-Control-Allow-Origin": "*" }
            });
        }

        try {
            // Embed font as @font-face data URI so resvg-wasm can render text
            const fontBase64 = await fontBase64Promise;
            const svgText = injectFontIntoSvg(processed.svgText, fontBase64);

            const resvg = new Resvg(svgText, {
                fitTo: { mode: "original" },
                font: {
                    loadSystemFonts: false,
                    defaultFontFamily: EDGE_FONT_FAMILY,
                },
                imageRendering: 1,
            });

            const response = new Response(resvg.render().asPng(), {
                status: 200,
                headers: { 
                    "Content-Type": "image/png", 
                    "Cache-Control": "public, max-age=86400",
                    "Access-Control-Allow-Origin": "*"
                }
            });

            if (request.method === "GET") {
                ctx.waitUntil(caches.default.put(request, response.clone()));
            }
            return response;

        } catch (error) {
            return new Response(JSON.stringify({ error: error.message }), { 
                status: 500,
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
            });
        }
    }
};