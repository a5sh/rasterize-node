import { initWasm, Resvg } from "@resvg/resvg-wasm";
// Cloudflare injects the compiled WASM module directly into this variable at boot
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import { processRequest } from "../core/logic.js";

let wasmInitialized = false;

export default {
    async fetch(request, env, ctx) {
        // Cold Start: WASM is already in memory, initialization is instantaneous (< 1ms)
        if (!wasmInitialized) {
            await initWasm(resvgWasm);
            wasmInitialized = true;
        }

        const getBodyText = async () => await request.text();
        const processed = await processRequest(request.url, request.method, request.headers, getBodyText, env);

        if (processed.status !== 200 || !processed.svgText) {
            return new Response(processed.body, { status: processed.status });
        }

        try {
            const resvg = new Resvg(processed.svgText, {
                fitTo: { mode: "original" },
                font: { loadSystemFonts: false }, 
                imageRendering: 1 
            });

            const response = new Response(resvg.render().asPng(), {
                status: 200,
                headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" }
            });

            // Cache on the Edge dynamically
            ctx.waitUntil(caches.default.put(request, response.clone()));
            return response;

        } catch (error) {
            return new Response(JSON.stringify({ error: error.message }), { status: 500 });
        }
    }
};