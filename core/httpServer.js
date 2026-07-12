// core/httpServer.js
//
// Shared HTTP server factory for all long-lived rasterizer nodes
// (VPS, Render, Railway, Fly.io, etc.).
//
// Centralises all route handling so vps/server.js and render/server.js
// are thin boot scripts with no duplicated logic.
//
// Usage:
//   import { createRasterServer } from '../core/httpServer.js'; // or ./lib/httpServer.js
//   const server = createRasterServer({ pool, embedImages, generatePoster, generateSquare, discord });
//   server.listen(port, '0.0.0.0', callback);

import http from "node:http";
import { gunzipSync, brotliDecompressSync } from "node:zlib";

// ── Decompression ─────────────────────────────────────────────────────────────

export function decompressSvgBody(buf, req) {
  const encoding = (
    req.headers["x-svg-encoding"] ||
    req.headers["content-encoding"] ||
    ""
  ).toLowerCase();
  if (!encoding || buf.length === 0) return buf;
  try {
    if (encoding === "gzip") return gunzipSync(buf);
    if (encoding === "br" || encoding === "brotli")
      return brotliDecompressSync(buf);
  } catch (e) {
    console.warn(
      `[decompress] Failed (${encoding}): ${e.message} — using raw body`,
    );
  }
  return buf;
}

// ── Body reader ───────────────────────────────────────────────────────────────

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (err) => {
      err._clientAbort = true;
      reject(err);
    });
    req.on("close", () => {
      if (!req.complete)
        reject(Object.assign(new Error("aborted"), { _clientAbort: true }));
    });
  });
}

// ── wsrv.nl fallback ─────────────────────────────────────────────────────────

export async function fetchFromWsrv(svgUrl, format) {
  const u = new URL("https://wsrv.nl/");
  u.searchParams.set("url", svgUrl);
  u.searchParams.set(
    "output",
    format === "webp" ? "webp" : format === "png" ? "png" : "jpg",
  );
  u.searchParams.set("q", "100");
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 6_000);
  try {
    const res = await fetch(u.toString(), {
      signal: ac.signal,
      headers: { "User-Agent": "SpicyDevs-Rasterizer/3.2" },
    });
    if (!res.ok) throw new Error(`wsrv.nl returned ${res.status}`);
    return res;
  } finally {
    clearTimeout(t);
  }
}

// ── Server factory ────────────────────────────────────────────────────────────

/**
 * Creates a fully-configured http.Server for rasterization.
 *
 * @param {object}   opts
 * @param {object}   opts.pool            RenderPool instance
 * @param {Function} opts.embedImages     (svgText, ua) => Promise<string>
 * @param {Function} opts.generatePoster  (url, fmt) => Promise<{buffer, mimeType}>
 * @param {Function} opts.generateSquare  (url, fmt) => Promise<{buffer, mimeType}>
 * @param {object}   opts.discord         { stats, recordRequest, recordJobDuration,
 *                                          recordResvgFail, recordWsrvFallback, logError }
 * @param {string}   [opts.version]       reported in /health
 * @param {number}   [opts.maxConcurrent] reported in /health
 *
 * @returns {http.Server}
 */
export function createRasterServer({
  pool,
  embedImages,
  generatePoster,
  generateSquare,
  discord,
  version = "3.2",
  maxConcurrent = 4,
}) {
  const {
    stats,
    recordRequest,
    recordJobDuration,
    recordResvgFail,
    recordWsrvFallback,
    logError,
  } = discord;

  function syncStats() {
    if (!pool) return;
    stats.activeJobs = pool.activeJobs;
    stats.queuedJobs = pool.queuedJobs;
  }

  // AFTER — httpServer.js doesn't call applyFauxBold itself (renderPool's
  // worker thread does, inside renderWorker.js, which is already fixed
  // above). No change needed here — noting for completeness since this was
  // the other candidate call site checked.
  async function renderSvg(svgText, format) {
    return pool.render(
      await embedImages(svgText, "SpicyDevs-Rasterizer/3.2"),
      format,
    );
  }

  // ── Route handlers ──────────────────────────────────────────────────────────

  function handleHealth(res) {
    syncStats();
    const fontCfg = pool?._resvgOpts?.font ?? null;
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(
      JSON.stringify({
        status: "ok",
        version,
        ts: Date.now(),
        activeJobs: stats.activeJobs,
        queuedJobs: stats.queuedJobs,
        workerCount: pool?.workerCount ?? 0,
        pendingRespawns: pool?.pendingRespawns ?? 0,
        maxConcurrent,
        uptime: Math.floor(process.uptime()),
        fontDefault: fontCfg?.defaultFontFamily ?? null,
        fontFiles: fontCfg?.fontFiles ?? [],
      }),
    );
  }

  async function handleB2p(req, res, params, bodyBuf) {
    let imageUrl = params.get("url");
    if (req.method === "POST" && bodyBuf?.length) {
      if (req.headers["content-type"]?.includes("application/json")) {
        try {
          imageUrl = JSON.parse(bodyBuf).url || imageUrl;
        } catch {}
      } else {
        imageUrl = bodyBuf.toString("utf8").trim() || imageUrl;
      }
    }
    if (!imageUrl) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({ error: "Missing url parameter or body content" }),
      );
    }

    const cropMode = params.get("crop") || "";
    const format = params.get("format") || "jpeg";
    const t0 = Date.now();

    const { buffer, mimeType } =
      cropMode === "square"
        ? await generateSquare(imageUrl, format)
        : await generatePoster(imageUrl, format);

    recordJobDuration(Date.now() - t0);
    syncStats();
    res.writeHead(200, {
      "Content-Type": mimeType,
      "Cache-Control": "public, max-age=86400",
      "X-Crop-Mode": cropMode || "poster",
    });
    res.end(buffer);
  }

  async function handleJsonBody(req, res, params, bodyBuf) {
    const format = params.get("format") || req.headers["x-format"] || "png";
    const fallbackUrl = params.get("fallback_url") || null;

    if (!bodyBuf?.length) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Empty body" }));
    }
    let payload;
    try {
      payload = JSON.parse(bodyBuf);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Invalid JSON" }));
    }

    // ── Single job ──────────────────────────────────────────────────────────
    if (payload.svgText) {
      const fmt = payload.format || format;
      const t0 = Date.now();
      try {
        const { buffer, mimeType } = await renderSvg(payload.svgText, fmt);
        const computeMs = Date.now() - t0;
        recordJobDuration(computeMs);
        syncStats();
        res.writeHead(200, {
          "Content-Type": mimeType,
          "Cache-Control": "public, max-age=86400",
          "X-Render-Ms": String(computeMs),
        });
        return res.end(buffer);
      } catch (resvgErr) {
        recordResvgFail();
        syncStats();
        const fallback = payload.svgUrl || fallbackUrl;
        if (fallback) {
          try {
            recordWsrvFallback();
            const wsrvRes = await fetchFromWsrv(fallback, fmt);
            recordJobDuration(Date.now() - t0);
            const buf = Buffer.from(await wsrvRes.arrayBuffer());
            res.writeHead(200, {
              "Content-Type":
                wsrvRes.headers.get("content-type") || "image/png",
              "Cache-Control": "public, max-age=86400",
            });
            return res.end(buf);
          } catch (wsrvErr) {
            const msg = `resvg: ${resvgErr.message} | wsrv: ${wsrvErr.message}`;
            await logError("Single JSON job failed", msg);
            res.writeHead(502, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: msg }));
          }
        }
        await logError(
          "Single JSON job failed (no fallback)",
          resvgErr.message,
        );
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: resvgErr.message }));
      }
    }

    // ── Bulk jobs ───────────────────────────────────────────────────────────
    if (!Array.isArray(payload.jobs)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({ error: "Expected { svgText } or { jobs: [] }" }),
      );
    }
    const results = await Promise.all(
      payload.jobs.map(async (job) => {
        const t0 = Date.now();
        const fmt = job.format || "png";
        try {
          const { buffer, mimeType } = await renderSvg(job.svgText, fmt);
          recordJobDuration(Date.now() - t0);
          syncStats();
          return {
            id: job.id,
            status: "success",
            mimeType,
            data: buffer.toString("base64"),
          };
        } catch (resvgErr) {
          recordResvgFail();
          if (job.svgUrl) {
            try {
              recordWsrvFallback();
              const wsrvRes = await fetchFromWsrv(job.svgUrl, fmt);
              recordJobDuration(Date.now() - t0);
              const buf = Buffer.from(await wsrvRes.arrayBuffer());
              return {
                id: job.id,
                status: "success",
                mimeType: wsrvRes.headers.get("content-type") || "image/png",
                data: buf.toString("base64"),
              };
            } catch (wsrvErr) {
              return {
                id: job.id,
                status: "error",
                error: `resvg: ${resvgErr.message} | wsrv: ${wsrvErr.message}`,
              };
            }
          }
          return { id: job.id, status: "error", error: resvgErr.message };
        }
      }),
    );
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ results }));
  }

  async function handleLegacy(req, res, params, bodyBuf) {
    const format = params.get("format") || req.headers["x-format"] || "png";
    const fallbackUrl = params.get("fallback_url") || null;

    let svgText;
    if (req.method === "POST") {
      if (!bodyBuf?.length) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        return res.end("Empty SVG body");
      }
      svgText = bodyBuf.toString("utf8");
    } else if (req.method === "GET") {
      const targetUrl = params.get("url");
      if (!targetUrl) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        return res.end("Missing ?url= parameter");
      }
      const r = await fetch(targetUrl, {
        headers: { "User-Agent": "SpicyDevs-Rasterizer/3.2" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!r.ok) {
        res.writeHead(502, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({ error: `SVG fetch failed: ${r.status}` }),
        );
      }
      svgText = await r.text();
    } else {
      res.writeHead(405, { "Content-Type": "text/plain" });
      return res.end("Method not allowed");
    }

    const t0 = Date.now();
    try {
      const { buffer, mimeType } = await renderSvg(svgText, format);
      const computeMs = Date.now() - t0;
      recordJobDuration(computeMs);
      syncStats();
      res.writeHead(200, {
        "Content-Type": mimeType,
        "Cache-Control": "public, max-age=86400",
        "X-Render-Ms": String(computeMs),
      });
      res.end(buffer);
    } catch (resvgErr) {
      recordResvgFail();
      syncStats();
      if (fallbackUrl) {
        try {
          recordWsrvFallback();
          const wsrvRes = await fetchFromWsrv(fallbackUrl, format);
          recordJobDuration(Date.now() - t0);
          const buf = Buffer.from(await wsrvRes.arrayBuffer());
          res.writeHead(200, {
            "Content-Type": wsrvRes.headers.get("content-type") || "image/png",
            "Cache-Control": "public, max-age=86400",
          });
          res.end(buf);
        } catch (wsrvErr) {
          const msg = `resvg: ${resvgErr.message} | wsrv: ${wsrvErr.message}`;
          await logError("Legacy job failed", msg);
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: msg }));
        }
      } else {
        await logError("Legacy job failed (no fallback)", resvgErr.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: resvgErr.message }));
      }
    }
  }

  // ── Main request handler ────────────────────────────────────────────────────

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, X-Format, X-SVG-Encoding",
      });
      return res.end();
    }

    const qIdx = req.url.indexOf("?");
    const pathname = qIdx === -1 ? req.url : req.url.slice(0, qIdx);
    const params = new URLSearchParams(qIdx === -1 ? "" : req.url.slice(qIdx));

    if (pathname === "/health") return handleHealth(res);

    if (!pool) {
      res.writeHead(503, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({ error: "Initialising — retry in a moment." }),
      );
    }

    try {
      recordRequest();
      const rawBodyBuf = req.method === "POST" ? await readBody(req) : null;
      const bodyBuf = rawBodyBuf ? decompressSvgBody(rawBodyBuf, req) : null;
      syncStats();

      if (pathname === "/b2p") return handleB2p(req, res, params, bodyBuf);
      if (req.headers["content-type"]?.includes("application/json"))
        return handleJsonBody(req, res, params, bodyBuf);
      return handleLegacy(req, res, params, bodyBuf);
    } catch (err) {
      if (err._clientAbort) return;
      await logError("Unhandled server error", err.message);
      if (!res.headersSent)
        res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;
  server.on("connection", (s) => s.setNoDelay(true));

  return server;
}
