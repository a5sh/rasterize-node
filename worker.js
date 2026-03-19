import { initWasm } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import { handleRasterizeRequest } from "./src/core.js";

// Singleton promise prevents race conditions during cold starts
let wasmPromise = null;

export default {
  async fetch(request, env, ctx) {
    if (!wasmPromise) {
      wasmPromise = initWasm(resvgWasm);
    }

    const cacheStore = caches.default;
    const platformCache = {
      match: (req) => cacheStore.match(req),
      put: (req, res) => ctx.waitUntil(cacheStore.put(req, res))
    };

    return handleRasterizeRequest(request, env, platformCache, wasmPromise);
  }
};