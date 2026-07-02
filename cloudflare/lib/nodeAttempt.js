// cloudflare/lib/nodeAttempt.js
//
// Single-node raster attempt dispatch: URL-payload GET (Vercel, wsrv.nl)
// vs POST-body (everyone else, with optional gzip), plus the gzip helper.

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
 * Attempt a single raster node. Records health/error state via `health`.
 *
 * @param {object} node
 * @param {string} svgText
 * @param {string|null} svgUrl
 * @param {string} format
 * @param {AbortSignal} signal
 * @param {object} health - createHealthState() instance
 * @returns {Promise<{ok, res, error, status, inflightAtStart}>}
 */
export async function tryNode(node, svgText, svgUrl, format, signal, health) {
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
      // Body POST path — optionally gzip
      let body = svgText,
        ct = "image/svg+xml";
      const extra = {};
      if (
        node.acceptsCompression === "gzip" ||
        node.acceptsCompression === true
      ) {
        const gz = await gzip(svgText);
        if (gz) {
          body = gz;
          ct = "application/octet-stream";
          extra["X-SVG-Encoding"] = "gzip";
        }
      }
      // 'br' reserved for when CF Workers' CompressionStream adds brotli support
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
      };
    }
    health.recordOk(node.id);
    return { ok: true, res, error: "", status: res.status, inflightAtStart };
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
