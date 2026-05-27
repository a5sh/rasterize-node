// vercel/api/rasterize.js
//
// v7.1 — serverlessReporter added
// ─────────────────────────────────────────────────────────────────────────────
// Metrics (request count, job duration percentiles, error rate) are now
// accumulated in module-level memory and flushed to the CF Discord hub via
// maybeReport() after each render. No Discord dependency in this file.

import { gunzipSync } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";
import { applyFauxBold } from "../lib/fauxBold.js";
import { buildResvgOpts } from "../lib/sharedRender.js";
import {
  expandIconPlaceholder,
  warmIconCache,
  iconCacheStatus,
} from "../lib/iconCache.js";
import {
  recordRequest,
  recordJobDuration,
  recordError,
  recordResvgFail,
  maybeReport,
} from "../lib/serverlessReporter.js";

// NODE_NAME must match the id used in CF worker's getNodes() — set via
// Vercel dashboard: Settings > Environment Variables > NODE_NAME = vercel-usw
const NODE_NAME = process.env.NODE_NAME || "vercel-usw";

const RESVG_OPTS = buildResvgOpts();

warmIconCache();

export const config = { maxDuration: 10 };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Format, X-SVG-Encoding",
};

// ── Decompression ─────────────────────────────────────────────────────────────

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

// ── External image embedding ──────────────────────────────────────────────────

async function embedExternalImages(svgText) {
  const matches = [...svgText.matchAll(/href="(https?:\/\/[^"]+)"/g)];
  if (!matches.length) return svgText;
  const unique = [...new Set(matches.map((m) => m[1]))];
  const reps = await Promise.all(
    unique.map(async (url) => {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(8_000),
          headers: { "User-Agent": "SpicyDevs-Rasterizer/7.1" },
        });
        if (!res.ok) return { url, dataUri: null };
        const buf = Buffer.from(await res.arrayBuffer());
        const ct = res.headers.get("content-type") || "image/jpeg";
        return { url, dataUri: `data:${ct};base64,${buf.toString("base64")}` };
      } catch {
        return { url, dataUri: null };
      }
    }),
  );
  for (const { url, dataUri } of reps)
    if (dataUri)
      svgText = svgText.split(`href="${url}"`).join(`href="${dataUri}"`);
  return svgText;
}

// ── Render pipeline ───────────────────────────────────────────────────────────

async function renderToBuffer(svgText, format) {
  const withIcons = await expandIconPlaceholder(svgText);
  const embedded = await embedExternalImages(withIcons);
  const processed = applyFauxBold(embedded);
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

/**
 * Wraps renderToBuffer with metric recording.
 * recordRequest() is called by the caller so bulk jobs aren't double-counted.
 */
async function renderAndRecord(svgText, format) {
  const t0 = Date.now();
  try {
    const result = await renderToBuffer(svgText, format);
    recordJobDuration(Date.now() - t0);
    return result;
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

function sendImage(res, buffer, mimeType) {
  res.writeHead(200, {
    "Content-Type": mimeType,
    "Cache-Control": "public, max-age=86400",
    "X-Node": NODE_NAME,
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

  // ── Health check ──────────────────────────────────────────────────────────
  if (url.pathname === "/health") {
    return sendJson(res, 200, {
      status: "ok",
      version: "7.1",
      node: NODE_NAME,
      fontReady: !!RESVG_OPTS.font?.fontFiles?.length,
      iconCache: iconCacheStatus(),
    });
  }

  // ── GET ?url= ─────────────────────────────────────────────────────────────
  if (req.method === "GET") {
    const targetUrl = url.searchParams.get("url");
    if (!targetUrl)
      return sendJson(res, 400, { error: "Missing ?url= parameter" });

    recordRequest();
    try {
      const r = await fetch(targetUrl, {
        signal: AbortSignal.timeout(8_000),
        headers: { "User-Agent": "SpicyDevs-Rasterizer/7.1" },
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

  // ── POST ──────────────────────────────────────────────────────────────────
  if (req.method === "POST") {
    const ct = req.headers["content-type"] || "";
    const encoding = req.headers["x-svg-encoding"] || "";
    const bodyBuf = await readBody(req);

    // ── JSON body (single or bulk) ────────────────────────────────────────
    if (ct.includes("application/json")) {
      if (!bodyBuf.length) return sendJson(res, 400, { error: "Empty body" });

      let payload;
      try {
        payload = JSON.parse(bodyBuf);
      } catch {
        return sendJson(res, 400, { error: "Invalid JSON" });
      }

      // Single job
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

      // Bulk jobs
      if (Array.isArray(payload.jobs)) {
        const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "4", 10);
        const results = [];
        for (let i = 0; i < payload.jobs.length; i += MAX_CONCURRENT) {
          const slice = payload.jobs.slice(i, i + MAX_CONCURRENT);
          const batch = await Promise.all(
            slice.map(async (job) => {
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

    // ── Raw SVG body (may be gzip-compressed) ─────────────────────────────
    if (!bodyBuf.length) return sendJson(res, 400, { error: "Empty SVG body" });

    recordRequest();
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
