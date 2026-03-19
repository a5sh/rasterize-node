import { initWasm } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm?module";
import { handleRasterizeRequest } from "../src/core.js";

export const config = {
  runtime: "edge",
};

let wasmPromise = null;

export default async function handler(request) {
  if (!wasmPromise) {
    wasmPromise = initWasm(resvgWasm);
  }

  // Vercel Edge maps environment variables to process.env
  const env = process.env;

  // Rely strictly on Vercel's Edge Cache via the Cache-Control headers returned by core
  const platformCache = null; 

  return handleRasterizeRequest(request, env, platformCache, wasmPromise);
}