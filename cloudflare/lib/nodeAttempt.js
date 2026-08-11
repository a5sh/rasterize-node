// cloudflare/lib/nodeAttempt.js
//
// Single-node raster attempt dispatch: URL-payload GET (Vercel, wsrv.nl)
// vs POST-body (everyone else, with gzip), plus gzip helpers.
//
// Compression notes (Cloudflare runtime, 2026):
//   • CompressionStream/DecompressionStream (Web API, implemented by the
//     workerd runtime) support gzip / deflate / deflate-raw — NOT brotli.
//     In-stream brotli would need a WASM codec, so the node uplink stays gzip.
//   • The rasterizer's outbound responses (SVG/JSON) are compressed by the
//     CF edge automatically (brotli/zstd/gzip negotiated per client) — that
//     is a Cloudflare-native feature, nothing to do in code.
//   • The same gzipped payload is built ONCE per request (raceDispatch.js)
//     and reused for every POST node — never re-compressed per attempt.

export async function gzip(text) {
  try {
    const ds = new CompressionStream("gzip");
    const w = ds.writable.getWriter();
    w.write(new TextEncoder().encode(text));
    w.close();
    return await new Response(ds.readable).arrayBuffer();
  } catch {
    return null;
  }
}

/**
 * Stream-decompress a gzip request body (Web API DecompressionStream, as
 * implemented by the workerd runtime). `request.body` is piped straight
 * through the decompressor — no intermediate buffering (true streaming).
 */
export async function decompressGzipStream(body) {
  return await new Response(
    body.pipeThrough(new DecompressionStream("gzip")),
  ).text();
}

/**
 * Attempt a single raster node. Records health/error state via `health`.
 *
 * @param {object} node
 * @param {string} svgText
 * @param {string|null} svgUrl
 * @param {string} format
 * @param {AbortSignal} signal
 * @param {object} health - createHealthState() instance
 * @param {ArrayBuffer|null} [precompressed] - gzip bytes of svgText, built
 *   once per request by raceDispatch.js; reused by every POST node.
 * @returns {Promise<{ok, res, error, status, inflightAtStart}>}
 */
export async function tryNode(
  node,
  svgText,
  svgUrl,
  format,
  signal,
  health,
  precompressed = null,
) {
  health.acquireInflight(node.id);
  const inflightAtStart = health.inFlight(node.id);
  try {
    let res;
    if (node.useUrlPayload && svgUrl) {
      let target;
      if (node.id === "wsrv") {
        const src = new URL(svgUrl);
        src.hostname = "posterium-backend.aayu5h.workers.dev";
        src.searchParams.delete("no_embed");
        const u = new URL("https://wsrv.nl/");
        u.searchParams.set("url", src.toString());
        u.searchParams.set(
          "output",
          format === "webp"
            ? "webp"
            : format === "jpg" || format === "jpeg"
              ? "jpeg"
              : "png",
        );
        u.searchParams.set("q", "100");
        target = u.toString();
      } else {
        // Vercel: GET ?url=&format=
        const u = new URL(node.url);
        u.searchParams.set("url", svgUrl);
        u.searchParams.set("format", format);
        target = u.toString();
      }
      res = await fetch(target, {
        method: "GET",
        headers: { "User-Agent": "SpicyDevs-LB/12.0" },
        signal,
      });
    } else {
      // Body POST path — gzip once per request, reused across nodes
      let body = svgText,
        ct = "image/svg+xml";
      const extra = {};
      if (
        node.acceptsCompression === "gzip" ||
        node.acceptsCompression === true
      ) {
        const gz = precompressed ?? (await gzip(svgText));
        if (gz) {
          body = gz;
          ct = "application/octet-stream";
          extra["X-SVG-Encoding"] = "gzip";
        }
      }
      res = await fetch(node.url, {
        method: "POST",
        body,
        headers: {
          "Content-Type": ct,
          "X-Format": format,
          "User-Agent": "SpicyDevs-LB/12.0",
          ...extra,
        },
        signal,
      });
    }

    if (!res.ok) {
      health.recordErr(node.id);
      return {
        ok: false,
        res: null,
        error: `http_${res.status}`,
        status: res.status,
        inflightAtStart,
        computeMs: 0,
      };
    }
    health.recordOk(node.id);
    // Self-reported node-side render time, if the node emits it (see
    // vercel/api/rasterize.js, netlify/functions/rasterize.js,
    // core/httpServer.js). 0 for wsrv.nl — no visibility into a third party.
    const computeMs = parseInt(res.headers.get("X-Render-Ms") || "", 10);
    return {
      ok: true,
      res,
      error: "",
      status: res.status,
      inflightAtStart,
      computeMs: Number.isFinite(computeMs) ? computeMs : 0,
    };
  } catch (e) {
    // AbortError is expected/benign here — either our own budget timeout
    // fired, or this racer lost the pair and its own controller was
    // aborted. Never record it as a node error and never let it escape
    // uncaught.
    if (e?.name !== "AbortError") health.recordErr(node.id);
    return {
      ok: false,
      res: null,
      inflightAtStart,
      computeMs: 0,
      error:
        e?.name === "AbortError"
          ? "timeout"
          : `throw:${e?.message?.slice(0, 60)}`,
      status: 0,
    };
  } finally {
    health.releaseInflight(node.id);
  }
}
