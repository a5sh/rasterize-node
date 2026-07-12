import { gunzipSync } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";
import { applyFauxBold } from "./fauxBold.js";
import { buildResvgOpts } from "./sharedRender.js";
import { iconCacheStatus } from "./iconCache.js";
import { embedExternalImages } from "./embedImages.js";
import {
  recordRequest,
  recordJobDuration,
  recordError,
  recordResvgFail,
  maybeReport,
} from "./serverlessReporter.js";
import { createRenderCache, makeCacheKey } from "./renderCache.js";

export function createServerlessHandler(nodeName) {
  const RESVG_OPTS = buildResvgOpts();
  const _renderCache = createRenderCache();

  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Format, X-SVG-Encoding",
  };

  function decompressBody(buf, encoding) {
    if (encoding === "gzip") {
      try {
        return gunzipSync(buf).toString("utf8");
      } catch {
        /* fall through */
      }
    }
    return buf.toString("utf8");
  }

  async function renderToBuffer(svgText, format) {
    const boldApplied = applyFauxBold(svgText);
    const processed = await embedExternalImages(
      boldApplied,
      "SpicyDevs-Rasterizer/7.2",
    );
    const resvg = new Resvg(processed, RESVG_OPTS);
    const rendered = resvg.render();

    if (
      (format === "jpg" || format === "jpeg") &&
      typeof rendered.asJpeg === "function"
    )
      return { buffer: rendered.asJpeg(85), mimeType: "image/jpeg" };
    if (format === "webp" && typeof rendered.asWebp === "function")
      return { buffer: rendered.asWebp(85), mimeType: "image/webp" };
    return { buffer: rendered.asPng(), mimeType: "image/png" };
  }

  async function renderAndRecord(svgText, format) {
    const t0 = Date.now();
    try {
      const result = await renderToBuffer(svgText, format);
      const computeMs = Date.now() - t0;
      recordJobDuration(computeMs);
      return { ...result, computeMs };
    } catch (e) {
      recordResvgFail();
      throw e;
    }
  }

  function renderWithCache(svgText, format) {
    const cacheKey = makeCacheKey(svgText, format);
    const cached = _renderCache.get(cacheKey);
    if (cached)
      return { buffer: cached.buffer, mimeType: cached.mimeType, computeMs: 0 };

    const p = renderAndRecord(svgText, format);
    return p.then((result) => {
      _renderCache.set(cacheKey, {
        buffer: result.buffer,
        mimeType: result.mimeType,
        key: cacheKey,
      });
      return result;
    });
  }

  return {
    CORS,
    RESVG_OPTS,
    decompressBody,
    renderToBuffer,
    renderAndRecord,
    renderWithCache,
    iconCacheStatus,
    recordRequest,
    recordJobDuration,
    recordError,
    recordResvgFail,
    maybeReport,
  };
}
