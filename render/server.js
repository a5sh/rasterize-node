//render/server.js
//
// Render.com rasterizer boot script.
// build.mjs always populates ./lib/ before this runs — import directly,
// no dynamic resolver needed (that's a VPS concern for Pterodactyl).
// Render rebuilds the container on every GitHub push; no auto-updater.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RenderPool } from "./lib/renderPool.js";
import { buildResvgOpts } from "./lib/sharedRender.js";
import {
  generatePosterFromBackdrop,
  generateSquareCropFromBackdrop,
} from "./lib/b2p.js";
import { warmIconCache } from "./lib/iconCache.js";
import { embedExternalImages } from "./lib/embedImages.js";
import { createRasterServer } from "./lib/httpServer.js";
import * as discord from "./discord.js";

// Render injects PORT automatically; default matches Render's expectation.
const PORT = parseInt(process.env.PORT || "10000", 10);
// Render free tier has limited shared CPU — keep threads conservative.
// Override via MAX_CONCURRENT in the Render dashboard env vars.
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "2", 10);

const __dir = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dir, "lib", "renderWorker.js");

// Stagger icon-cache fetch to prevent burst on redeploy / rolling restart
setTimeout(() => warmIconCache(), Math.floor(Math.random() * 20_000));

(async () => {
  const resvgOpts = buildResvgOpts();
  console.log("[resvg] Font config:", JSON.stringify(resvgOpts.font, null, 2));

  const pool = new RenderPool(WORKER_PATH, __dir, MAX_CONCURRENT, resvgOpts);
  console.log(`[pool]  ${MAX_CONCURRENT} worker threads spawned`);

  const server = createRasterServer({
    pool,
    embedImages: embedExternalImages,
    generatePoster: generatePosterFromBackdrop,
    generateSquare: generateSquareCropFromBackdrop,
    discord,
    version: "3.2",
    maxConcurrent: MAX_CONCURRENT,
  });

  server.listen(PORT, "0.0.0.0", async () => {
    console.log(`Rasterizer ready on :${PORT} (${MAX_CONCURRENT} workers)`);
    await discord.notifyOnline();
  });

  async function shutdown(signal) {
    console.log(`[${signal}] shutting down`);
    await discord.notifyOffline(signal);
    await pool.destroy();
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
})();
