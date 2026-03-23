import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import fontBuffer from "../core/NotoSans-Subset.ttf";  // bundled at deploy time
import { processRequest } from "../core/logic.js";

let wasmInitialized = false;

export default {
    async fetch(request, env, ctx) {
        if (!wasmInitialized) {
            await initWasm(resvgWasm);
            wasmInitialized = true;
        }

        const getBodyText = async () => await request.text();
        const processed = await processRequest(
            request.url, request.method, request.headers, getBodyText, env
        );

        if (processed.status !== 200 || !processed.svgText) {
            return new Response(processed.body, {
                status: processed.status,
                headers: { "Content-Type": processed.contentType || "text/plain", "Access-Control-Allow-Origin": "*" }
            });
        }

        try {
    console.log('[rasterize] svg length:', processed.svgText.length);
    console.log('[rasterize] svg preview:', processed.svgText.slice(0, 200));
    console.log('[rasterize] fontBuffer type:', Object.prototype.toString.call(fontBuffer), 'size:', fontBuffer?.byteLength);

            const resvg = new Resvg(processed.svgText, {
                fitTo: { mode: "original" },
                font: {
                    loadSystemFonts: false,
                    defaultFontFamily: "Noto Sans",
                    fontBuffers: [new Uint8Array(fontBuffer)],  // ArrayBuffer, zero decode overhead
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

        // edge-node/worker.js
} catch (error) {
    const msg = error instanceof Error 
        ? error.message 
        : (typeof error === 'string' ? error : JSON.stringify(error));
    console.error('[rasterize] render error:', msg, error?.stack || '');
    return new Response(JSON.stringify({ error: msg, stack: error?.stack }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
}
    }
};