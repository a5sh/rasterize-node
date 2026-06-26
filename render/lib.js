// render/lib.js
//
// Dynamic module resolver for the Render.com rasterizer node.
// Render clones the full GitHub repo on every deploy, so ../core is always
// available. Falls back to ./lib/ (built by scripts/build.mjs render) for
// any standalone or preview deploy without the full repo tree.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const coreDir = join(__dir, "..", "core");
const libDir = join(__dir, "lib");

const useCore = existsSync(join(coreDir, "renderPool.js"));
export const RESOLVED_LIB_DIR = useCore ? coreDir : libDir;

console.log(
  `[lib-resolver] Using ${useCore ? "../core (direct)" : "./lib (built)"}`,
);

const [poolMod, renderMod, iconMod, b2pMod, embedMod, httpMod] = useCore
  ? await Promise.all([
      import("../core/renderPool.js"),
      import("../core/sharedRender.js"),
      import("../core/iconCache.js"),
      import("../core/b2p.js"),
      import("../core/embedImages.js"),
      import("../core/httpServer.js"),
    ])
  : await Promise.all([
      import("./lib/renderPool.js"),
      import("./lib/sharedRender.js"),
      import("./lib/iconCache.js"),
      import("./lib/b2p.js"),
      import("./lib/embedImages.js"),
      import("./lib/httpServer.js"),
    ]);

export const { RenderPool } = poolMod;
export const { buildResvgOpts } = renderMod;
export const { expandIconPlaceholder, warmIconCache, iconCacheStatus } =
  iconMod;
export const { generatePosterFromBackdrop, generateSquareCropFromBackdrop } =
  b2pMod;
export const { embedExternalImages } = embedMod;
export const { createRasterServer } = httpMod;
