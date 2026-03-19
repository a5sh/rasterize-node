import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import { processRequest } from "../core/logic.js";

let wasmInitialized = false;

export default {
    async fetch(request, env, ctx) {
        if (!wasmInitialized) {
            await initWasm(resvgWasm);
            wasmInitialized = true;
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
            const resvg = new Resvg(processed.svgText, {
                fitTo: { mode: "original" },
                font: { loadSystemFonts: false }, 
                imageRendering: 1 
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