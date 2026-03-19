import { Resvg } from "@resvg/resvg-wasm";

const ALLOWED_HOSTS = ["api.spicydevs.xyz", "posters.spicydevs.xyz", "rpdb.padhaiaayush.workers.dev"];

export async function handleRasterizeRequest(request, env, platformCache, wasmPromise) {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    return new Response(JSON.stringify({ status: "ok", version: "1.2" }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }

  try {
    let svgText = "";

    if (request.method === "POST") {
      svgText = await request.text();
      if (!svgText) return new Response("Empty SVG body", { status: 400 });
    } 
    else if (request.method === "GET") {
      const targetSvgUrl = url.searchParams.get("url");
      if (!targetSvgUrl) return new Response("Missing ?url= parameter", { status: 400 });

      const targetUrlObj = new URL(targetSvgUrl);
      if (!ALLOWED_HOSTS.includes(targetUrlObj.hostname)) {
        return new Response("Unauthorized target domain", { status: 403 });
      }

      if (platformCache) {
        const cachedResponse = await platformCache.match(request);
        if (cachedResponse) return cachedResponse;
      }

      const svgRes = await fetch(targetSvgUrl, {
        headers: { "User-Agent": "SpicyDevs-Crowd-Rasterizer/1.2" }
      });
      
      if (!svgRes.ok) throw new Error(`SVG fetch failed: ${svgRes.status}`);
      svgText = await svgRes.text();
    } else {
      return new Response("Method not allowed", { status: 405 });
    }

    // Await the singleton promise to prevent initialization race conditions
    await wasmPromise;

    const resvg = new Resvg(svgText, {
      fitTo: { mode: "original" },
      font: { loadSystemFonts: false }, // System fonts do not exist on Edge isolates
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

    if (request.method === "GET" && platformCache) {
       platformCache.put(request, response.clone());
    }
    
    return response;

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { 
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
}