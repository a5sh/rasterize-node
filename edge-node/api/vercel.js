import { initWasm, Resvg } from "@resvg/resvg-wasm";
// Vercel pre-loads the WASM into memory via this specific import syntax
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm?module";
import { processRequest } from "../../core/logic.js";

export const config = { runtime: "edge" };
let wasmInitialized = false;

export default async function handler(request) {
    if (!wasmInitialized) {
        await initWasm(resvgWasm);
        wasmInitialized = true;
    }

    const getBodyText = async () => await request.text();
    // Vercel injects env vars into process.env even on the edge
    const processed = await processRequest(request.url, request.method, request.headers, getBodyText, process.env);

    if (processed.status !== 200 || !processed.svgText) {
        return new Response(processed.body, { status: processed.status });
    }

    const resvg = new Resvg(processed.svgText, {
        fitTo: { mode: "original" },
        font: { loadSystemFonts: false },
        imageRendering: 1
    });

    return new Response(resvg.render().asPng(), {
        status: 200,
        headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" }
    });
}