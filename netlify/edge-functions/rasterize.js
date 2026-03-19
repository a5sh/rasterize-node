import { initWasm } from "npm:@resvg/resvg-wasm@2.6.2";
import { handleRasterizeRequest } from "../../src/core.js";

let wasmPromise = null;

export default async (request, context) => {
  if (!wasmPromise) {
    // Deno environment fetches WASM dynamically
    wasmPromise = fetch(new URL("npm:@resvg/resvg-wasm@2.6.2/index_bg.wasm", import.meta.url))
      .then(res => res.arrayBuffer())
      .then(buf => initWasm(buf));
  }

  const env = Deno.env.toObject();

  // Rely on Netlify's CDN caching via Cache-Control headers
  const platformCache = null;

  return handleRasterizeRequest(request, env, platformCache, wasmPromise);
};

export const config = { path: "/rasterize" };