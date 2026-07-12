import { createServerlessHandler } from "../lib/serverlessHandler.js";

const NODE_NAME = process.env.NODE_NAME || "vercel-usw";
const {
  CORS,
  RESVG_OPTS,
  decompressBody,
  renderWithCache,
  iconCacheStatus,
  recordRequest,
  recordJobDuration,
  recordError,
  recordResvgFail,
  maybeReport,
} = createServerlessHandler(NODE_NAME);

export const config = { maxDuration: 10 };

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

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

  if (url.pathname === "/health") {
    return sendJson(res, 200, {
      status: "ok",
      version: "7.2",
      node: NODE_NAME,
      fontReady: !!RESVG_OPTS.font?.fontFiles?.length,
      iconCache: iconCacheStatus(),
    });
  }

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
      const { buffer, mimeType, computeMs } = await renderWithCache(
        svgText,
        format,
      );
      maybeReport(NODE_NAME).catch(() => {});
      return sendImage(res, buffer, mimeType, computeMs);
    } catch (e) {
      recordError();
      maybeReport(NODE_NAME).catch(() => {});
      return sendJson(res, 502, { error: e.message });
    }
  }

  if (req.method === "POST") {
    const ct = req.headers["content-type"] || "";
    const bodyBuf = await readBody(req);

    if (ct.includes("application/json")) {
      if (!bodyBuf.length)
        return sendJson(res, 400, { error: "Empty body" });
      let payload;
      try {
        payload = JSON.parse(bodyBuf);
      } catch {
        return sendJson(res, 400, { error: "Invalid JSON" });
      }

      if (payload.svgText) {
        recordRequest();
        const fmt = payload.format || format;
        try {
          const { buffer, mimeType, computeMs } = await renderWithCache(
            payload.svgText,
            fmt,
          );
          maybeReport(NODE_NAME).catch(() => {});
          return sendImage(res, buffer, mimeType, computeMs);
        } catch (e) {
          maybeReport(NODE_NAME).catch(() => {});
          return sendJson(res, 500, { error: e.message });
        }
      }

      if (Array.isArray(payload.jobs)) {
        const MAX_CONCURRENT = parseInt(
          process.env.MAX_CONCURRENT || "4",
          10,
        );
        const results = [];
        for (let i = 0; i < payload.jobs.length; i += MAX_CONCURRENT) {
          const batch = await Promise.all(
            payload.jobs.slice(i, i + MAX_CONCURRENT).map(async (job) => {
              recordRequest();
              const fmt = job.format || "png";
              try {
                const { buffer, mimeType } = await renderWithCache(
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

    if (!bodyBuf.length)
      return sendJson(res, 400, { error: "Empty SVG body" });
    recordRequest();
    const encoding = (
      req.headers["x-svg-encoding"] || ""
    ).toLowerCase();
    const svgText = decompressBody(bodyBuf, encoding);
    try {
      const { buffer, mimeType, computeMs } = await renderWithCache(
        svgText,
        format,
      );
      maybeReport(NODE_NAME).catch(() => {});
      return sendImage(res, buffer, mimeType, computeMs);
    } catch (e) {
      maybeReport(NODE_NAME).catch(() => {});
      return sendJson(res, 500, { error: e.message });
    }
  }

  return sendJson(res, 405, { error: "Method not allowed" });
}
