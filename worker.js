import { Resvg, initWasm } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";

let wasmInitialized = false;
const ALLOWED_HOSTS = ["api.spicydevs.xyz", "posters.spicydevs.xyz", "rpdb.padhaiaayush.workers.dev"];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", version: "1.1" }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    try {
      let svgText = "";

      // Handle POST: Main API sends raw SVG text via Service Binding
      if (request.method === "POST") {
        svgText = await request.text();
        if (!svgText) return new Response("Empty SVG body", { status: 400 });
      } 
      // Handle GET: Legacy crowd-node behavior
      else if (request.method === "GET") {
        const targetSvgUrl = url.searchParams.get("url");
        if (!targetSvgUrl) return new Response("Missing ?url= parameter", { status: 400 });

        const targetUrlObj = new URL(targetSvgUrl);
        if (!ALLOWED_HOSTS.includes(targetUrlObj.hostname)) {
          return new Response("Unauthorized target domain", { status: 403 });
        }

        const cache = caches.default;
        const cachedResponse = await cache.match(request);
        if (cachedResponse) return cachedResponse;

        const svgRes = await fetch(targetSvgUrl, {
          headers: { "User-Agent": "SpicyDevs-Crowd-Rasterizer/1.1" }
        });
        
        if (!svgRes.ok) throw new Error(`SVG fetch failed: ${svgRes.status}`);
        svgText = await svgRes.text();
      } else {
        return new Response("Method not allowed", { status: 405 });
      }

      if (!wasmInitialized) {
        await initWasm(resvgWasm);
        wasmInitialized = true;
      }

      const resvg = new Resvg(svgText, {
        fitTo: { mode: "original" },
        font: { loadSystemFonts: true },
        imageRendering: 1, 
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

      if (request.method === "GET") {
         ctx.waitUntil(caches.default.put(request, response.clone()));
      }
      return response;

    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { 
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
};