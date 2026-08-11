// cloudflare/lib/http.js
//
// Shared response + CORS helpers for the rasterize Worker. Import this from
// any cloudflare/ handler instead of hand-typing Response/ACAO boilerplate.

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token, X-Format, X-SVG-Encoding",
};

export function jsonOk(body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

export function jsonError(status, msg, extraHeaders = {}) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}
