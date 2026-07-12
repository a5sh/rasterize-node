import { createServerlessHandler } from "../lib/serverlessHandler.js";

const NODE_NAME = process.env.NODE_NAME || "netlify";
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

const jsonResp = (code, body) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json", ...CORS },
  body: JSON.stringify(body),
});

const imageResp = (buf, mime, computeMs = 0) => ({
  statusCode: 200,
  headers: {
    "Content-Type": mime,
    "Cache-Control": "public, max-age=86400",
    "X-Node": NODE_NAME,
    "X-Render-Ms": String(computeMs),
    ...CORS,
  },
  body: Buffer.from(buf).toString("base64"),
  isBase64Encoded: true,
});

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

  const bodyBuf = event.body
    ? event.isBase64Encoded
      ? Buffer.from(event.body, "base64")
      : Buffer.from(event.body, "utf-8")
    : Buffer.alloc(0);

  if (pathname === "/health") {
    return jsonResp(200, {
      status: "ok",
      version: "7.2",
      node: NODE_NAME,
      fontReady: !!RESVG_OPTS.font?.fontFiles?.length,
      iconCache: iconCacheStatus(),
    });
  }

  if (event.httpMethod === "GET") {
    const targetUrl = params.get("url");
    if (!targetUrl)
      return jsonResp(400, { error: "Missing ?url= parameter" });

    recordRequest();
    try {
      const r = await fetch(targetUrl, {
        signal: AbortSignal.timeout(8_000),
        headers: { "User-Agent": "SpicyDevs-Rasterizer/7.2" },
      });
      if (!r.ok) {
        recordError();
        maybeReport(NODE_NAME).catch(() => {});
        return jsonResp(502, { error: `SVG fetch failed: ${r.status}` });
      }
      const svgText = await r.text();
      const { buffer, mimeType, computeMs } = await renderWithCache(
        svgText,
        format,
      );
      maybeReport(NODE_NAME).catch(() => {});
      return imageResp(buffer, mimeType, computeMs);
    } catch (e) {
      recordError();
      maybeReport(NODE_NAME).catch(() => {});
      return jsonResp(502, { error: e.message });
    }
  }

  if (event.httpMethod === "POST") {
    const ct = headers["content-type"] || "";

    if (ct.includes("application/json")) {
      if (!bodyBuf.length)
        return jsonResp(400, { error: "Empty body" });
      let payload;
      try {
        payload = JSON.parse(bodyBuf.toString("utf8"));
      } catch {
        return jsonResp(400, { error: "Invalid JSON" });
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
          return imageResp(buffer, mimeType, computeMs);
        } catch (e) {
          maybeReport(NODE_NAME).catch(() => {});
          return jsonResp(500, { error: e.message });
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
      return jsonResp(400, {
        error: "Expected { svgText } or { jobs: [] }",
      });
    }

    if (!bodyBuf.length)
      return jsonResp(400, { error: "Empty SVG body" });
    recordRequest();
    const encoding = headers["x-svg-encoding"] || "";
    const svgText = decompressBody(bodyBuf, encoding);
    try {
      const { buffer, mimeType, computeMs } = await renderWithCache(
        svgText,
        format,
      );
      maybeReport(NODE_NAME).catch(() => {});
      return imageResp(buffer, mimeType, computeMs);
    } catch (e) {
      maybeReport(NODE_NAME).catch(() => {});
      return jsonResp(500, { error: e.message });
    }
  }

  return jsonResp(405, { error: "Method not allowed" });
};
