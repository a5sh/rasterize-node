import { initWasm, Resvg } from "npm:@resvg/resvg-wasm@2.6.2";
import { processRequest } from "../../../core/logic.js";

let wasmPromise = null;

export default async (request, context) => {
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

    if (!wasmPromise) {
        wasmPromise = fetch(new URL("npm:@resvg/resvg-wasm@2.6.2/index_bg.wasm", import.meta.url))
            .then(res => res.arrayBuffer())
            .then(buf => initWasm(buf));
    }
    await wasmPromise;

    const getBodyText = async () => await request.text();
    const env = Deno.env.toObject();
    
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

        return new Response(resvg.render().asPng(), {
            status: 200,
            headers: { 
                "Content-Type": "image/png", 
                "Cache-Control": "public, max-age=86400",
                "Access-Control-Allow-Origin": "*"
            }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { 
            status: 500,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
    }
};