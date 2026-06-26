// vps/server.js
//
// Pterodactyl / Docker / Railway / Fly.io rasterizer boot script.
// All HTTP route logic lives in core/httpServer.js — this file just wires
// the pool, resolves module paths, and manages process lifecycle.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RenderPool,
  buildResvgOpts,
  generatePosterFromBackdrop,
  generateSquareCropFromBackdrop,
  warmIconCache,
  embedExternalImages,
  createRasterServer,
  RESOLVED_LIB_DIR,
} from "./lib.js";

import * as discord from "./discord.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "4", 10);

const __dir = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(RESOLVED_LIB_DIR, "renderWorker.js");

// Stagger icon-cache warm across nodes to avoid simultaneous API bursts
// on fleet-wide restarts. 0–20 s jitter is imperceptible to users.
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
