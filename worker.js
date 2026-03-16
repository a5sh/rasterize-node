import { Resvg, initWasm } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";

let wasmInitialized = false;

// Restrict rasterization to your API to prevent SSRF abuse on crowd nodes
const ALLOWED_HOSTS = ["api.spicydevs.xyz", "posters.spicydevs.xyz", "rpdb.padhaiaayush.workers.dev"];

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });

    const url = new URL(request.url);
    const targetSvgUrl = url.searchParams.get("url");

    // Basic health check endpoint for your main API to verify node status
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", version: "1.0" }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    if (!targetSvgUrl) {
      return new Response("Missing ?url= parameter", { status: 400 });
    }

    try {
      const targetUrlObj = new URL(targetSvgUrl);
      if (!ALLOWED_HOSTS.includes(targetUrlObj.hostname)) {
        return new Response("Unauthorized target domain", { status: 403 });
      }

      // Check cache first
      const cache = caches.default;
      const cachedResponse = await cache.match(request);
      if (cachedResponse) return cachedResponse;

      const svgRes = await fetch(targetSvgUrl, {
        headers: { "User-Agent": "SpicyDevs-Crowd-Rasterizer/1.0" }
      });
      
      if (!svgRes.ok) throw new Error(`SVG fetch failed: ${svgRes.status}`);
      const svgText = await svgRes.text();

      if (!wasmInitialized) {
        await initWasm(resvgWasm);
        wasmInitialized = true;
      }

      const resvg = new Resvg(svgText, {
        fitTo: { mode: "original" },
        font: { loadSystemFonts: true },
        imageRendering: 1, // Crisp edges
      });

      const pngData = resvg.render();
      const pngBuffer = pngData.asPng();

      const response = new Response(pngBuffer, {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
          "Access-Control-Allow-Origin": "*"
        }
      });

      ctx.waitUntil(cache.put(request, response.clone()));
      return response;

    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { 
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
};
