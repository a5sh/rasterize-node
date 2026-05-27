// netlify/functions/rasterize.js
//
// v7.1 — serverlessReporter added
// ─────────────────────────────────────────────────────────────────────────────

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
// Netlify dashboard: Site settings > Environment variables > NODE_NAME = netlify
const NODE_NAME = process.env.NODE_NAME || "netlify";

const RESVG_OPTS = buildResvgOpts();

warmIconCache();

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

// ── Render helpers ────────────────────────────────────────────────────────────

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

// ── Response helpers ──────────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Format, X-SVG-Encoding",
};

const jsonResp = (code, body) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json", ...CORS },
  body: JSON.stringify(body),
});

const imageResp = (buf, mime) => ({
  statusCode: 200,
  headers: {
    "Content-Type": mime,
    "Cache-Control": "public, max-age=86400",
    "X-Node": NODE_NAME,
    ...CORS,
  },
  body: Buffer.from(buf).toString("base64"),
  isBase64Encoded: true,
});

// ── Lambda handler ────────────────────────────────────────────────────────────

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS")
    return { statusCode: 204, headers: CORS, body: "" };

  const pathname = (event.path || "/").split("?")[0];
  const params = new URLSearchParams(event.rawQuery || "");
  const headers = event.headers || {};
  const format = (
    headers["x-format"] ||
    params.get("format") ||
    "png"
  ).toLowerCase();

  // ── Health check ──────────────────────────────────────────────────────────
  if (pathname === "/health") {
    return jsonResp(200, {
      status: "ok",
      version: "7.1",
      node: NODE_NAME,
      fontReady: !!RESVG_OPTS.font?.fontFiles?.length,
      iconCache: iconCacheStatus(),
    });
  }

  const bodyBuf = event.body
    ? event.isBase64Encoded
      ? Buffer.from(event.body, "base64")
      : Buffer.from(event.body, "utf-8")
    : Buffer.alloc(0);

  const ct = headers["content-type"] || "";

  // ── JSON body ──────────────────────────────────────────────────────────
  if (ct.includes("application/json")) {
    if (!bodyBuf.length) return jsonResp(400, { error: "Empty body" });

    let payload;
    try {
      payload = JSON.parse(bodyBuf.toString("utf8"));
    } catch {
      return jsonResp(400, { error: "Invalid JSON" });
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
        return imageResp(buffer, mimeType);
      } catch (e) {
        maybeReport(NODE_NAME).catch(() => {});
        return jsonResp(500, { error: e.message });
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
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          ...CORS,
        },
        body: JSON.stringify({ results }),
      };
    }

    return jsonResp(400, { error: "Expected { svgText } or { jobs: [] }" });
  }

  // ── GET ?url= ──────────────────────────────────────────────────────────
  if (event.httpMethod === "GET") {
    const targetUrl = params.get("url");
    if (!targetUrl) return jsonResp(400, { error: "Missing ?url= parameter" });

    recordRequest();
    try {
      const r = await fetch(targetUrl, {
        signal: AbortSignal.timeout(8_000),
        headers: { "User-Agent": "SpicyDevs-Rasterizer/7.1" },
      });
      if (!r.ok) {
        recordError();
        maybeReport(NODE_NAME).catch(() => {});
        return jsonResp(502, { error: `SVG fetch failed: ${r.status}` });
      }
      const svgText = await r.text();
      const { buffer, mimeType } = await renderAndRecord(svgText, format);
      maybeReport(NODE_NAME).catch(() => {});
      return imageResp(buffer, mimeType);
    } catch (e) {
      recordError();
      maybeReport(NODE_NAME).catch(() => {});
      return jsonResp(502, { error: e.message });
    }
  }

  // ── POST raw SVG ───────────────────────────────────────────────────────
  if (event.httpMethod === "POST") {
    if (!bodyBuf.length) return jsonResp(400, { error: "Empty SVG body" });

    recordRequest();
    const encoding = headers["x-svg-encoding"] || "";
    const svgText = decompressBody(bodyBuf, encoding);

    try {
      const { buffer, mimeType } = await renderAndRecord(svgText, format);
      maybeReport(NODE_NAME).catch(() => {});
      return imageResp(buffer, mimeType);
    } catch (e) {
      maybeReport(NODE_NAME).catch(() => {});
      return jsonResp(500, { error: e.message });
    }
  }

  return jsonResp(405, { error: "Method not allowed" });
};
