// vercel/api/rasterize.js
//
// v7.2 — gzip dead code removed (vercel uses GET ?url= only, never gzip POST)
//       icon placeholder expansion removed (main API worker pre-expands icons)
//       embedExternalImages moved to shared lib/embedImages.js

import "dotenv/config";

// AFTER
import { gunzipSync } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";

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
import { applyFauxBold } from "../lib/fauxBold.js";
import { buildResvgOpts } from "../lib/sharedRender.js";
import { iconCacheStatus } from "../lib/iconCache.js";
import { embedExternalImages } from "../lib/embedImages.js";
import {
  recordRequest,
  recordJobDuration,
  recordError,
  recordResvgFail,
  maybeReport,
} from "../lib/serverlessReporter.js";

const NODE_NAME = process.env.NODE_NAME || "vercel-usw";
const RESVG_OPTS = buildResvgOpts();

export const config = { maxDuration: 10 };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Format, X-SVG-Encoding",
};

// ── Render pipeline ───────────────────────────────────────────────────────────

// AFTER
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

// ── Body reader ───────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ── Response helpers ──────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS });
  res.end(JSON.stringify(body));
}

function sendImage(res, buffer, mimeType, computeMs = 0) {
  res.writeHead(200, {
    "Content-Type": mimeType,
    "Cache-Control": "public, max-age=86400",
    "X-Node": NODE_NAME,
    "X-Render-Ms": String(computeMs),
    ...CORS,
  });
  res.end(Buffer.from(buffer));
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `https://${req.headers.host || "vercel.app"}`);
  const format = (
    req.headers["x-format"] ||
    url.searchParams.get("format") ||
    "png"
  ).toLowerCase();

  // ── Health ────────────────────────────────────────────────────────────────
  if (url.pathname === "/health") {
    return sendJson(res, 200, {
      status: "ok",
      version: "7.2",
      node: NODE_NAME,
      fontReady: !!RESVG_OPTS.font?.fontFiles?.length,
      iconCache: iconCacheStatus(),
    });
  }

  // ── GET ?url= (primary path — vercel only uses URL-payload) ───────────────
  if (req.method === "GET") {
    const targetUrl = url.searchParams.get("url");
    if (!targetUrl)
      return sendJson(res, 400, { error: "Missing ?url= parameter" });

    recordRequest();
    try {
      const r = await fetch(targetUrl, {
        signal: AbortSignal.timeout(8_000),
        headers: { "User-Agent": "SpicyDevs-Rasterizer/7.2" },
      });
      if (!r.ok) {
        recordError();
        maybeReport(NODE_NAME).catch(() => {});
        return sendJson(res, 502, { error: `SVG fetch failed: ${r.status}` });
      }
      const svgText = await r.text();
      const { buffer, mimeType } = await renderAndRecord(svgText, format);
      maybeReport(NODE_NAME).catch(() => {});
      return sendImage(res, buffer, mimeType);
    } catch (e) {
      recordError();
      maybeReport(NODE_NAME).catch(() => {});
      return sendJson(res, 502, { error: e.message });
    }
  }

  // ── POST (JSON single / JSON bulk / raw SVG) ──────────────────────────────
  if (req.method === "POST") {
    const ct = req.headers["content-type"] || "";
    const bodyBuf = await readBody(req);

    // JSON body
    if (ct.includes("application/json")) {
      if (!bodyBuf.length) return sendJson(res, 400, { error: "Empty body" });
      let payload;
      try {
        payload = JSON.parse(bodyBuf);
      } catch {
        return sendJson(res, 400, { error: "Invalid JSON" });
      }

      // Single
      if (payload.svgText) {
        recordRequest();
        const fmt = payload.format || format;
        try {
          const { buffer, mimeType } = await renderAndRecord(
            payload.svgText,
            fmt,
          );
          maybeReport(NODE_NAME).catch(() => {});
          return sendImage(res, buffer, mimeType);
        } catch (e) {
          maybeReport(NODE_NAME).catch(() => {});
          return sendJson(res, 500, { error: e.message });
        }
      }

      // Bulk
      if (Array.isArray(payload.jobs)) {
        const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "4", 10);
        const results = [];
        for (let i = 0; i < payload.jobs.length; i += MAX_CONCURRENT) {
          const batch = await Promise.all(
            payload.jobs.slice(i, i + MAX_CONCURRENT).map(async (job) => {
              recordRequest();
              const fmt = job.format || "png";
              try {
                const { buffer, mimeType } = await renderAndRecord(
                  job.svgText,
                  fmt,
                );
                return {
                  id: job.id,
                  status: "success",
                  mimeType,
                  data: Buffer.from(buffer).toString("base64"),
                };
              } catch (e) {
                return { id: job.id, status: "error", error: e.message };
              }
            }),
          );
          results.push(...batch);
        }
        maybeReport(NODE_NAME).catch(() => {});
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          ...CORS,
        });
        return res.end(JSON.stringify({ results }));
      }
      return sendJson(res, 400, {
        error: "Expected { svgText } or { jobs: [] }",
      });
    }

    // Raw SVG POST (no gzip: vercel has acceptsCompression: false)
    // AFTER
    if (!bodyBuf.length) return sendJson(res, 400, { error: "Empty SVG body" });
    recordRequest();
    const encoding = (req.headers["x-svg-encoding"] || "").toLowerCase();
    const svgText = decompressBody(bodyBuf, encoding);
    try {
      const { buffer, mimeType } = await renderAndRecord(svgText, format);
      maybeReport(NODE_NAME).catch(() => {});
      return sendImage(res, buffer, mimeType);
    } catch (e) {
      maybeReport(NODE_NAME).catch(() => {});
      return sendJson(res, 500, { error: e.message });
    }
  }

  return sendJson(res, 405, { error: "Method not allowed" });
}
