// assets/nodes.config.js
//
// Central raster node registry.
//
// T1 POOL (inLbWorker: true) — tried sequentially in geo order:
//   washington (Vercel US)   — URL-payload, no poster embed needed
//   ohio       (Netlify US)  — POST body
//   midas      (Spaceify EU) — POST body, 100% CPU alloc
//   germany    (Spaceify EU) — POST body, ~100% CPU alloc
//   danbot     (DanBot EU)   — POST body, 200% CPU alloc
//   wsrv       (Global CDN)  — URL-payload, librsvg
//
// T2 FALLBACK (isLbFallback: true) — tried only after all T1 fail:
//   france  (Spaceify FR)    — POST body
//   render_eu (Render EUC)   — POST body
//
// lbRegion: 'NA' | 'EU' — used for geo ordering

export default {
  settings: {
    // T1 per-node attempt timeout
    t1TimeoutMs: 5_000,
    // T2 (extreme fallback) timeout — longer, last resort
    t2TimeoutMs: 8_000,
    // wsrv.nl timeout (URL-payload, global CDN, usually fast)
    wsrvTimeoutMs: 5_000,
    // Poster embedding timeout in Worker B
    posterEmbedTimeoutMs: 6_000,
    // Max wall time before issuing TMDB redirect fallback
    maxWallTimeMs: 7_000,
    // Error window for per-node health tracking
    errWindowMs: 60_000,
    // Threshold to mark a node as stressed (skip to next)
    stressThreshold: 3,
    // Threshold to mark a node as failing (deprioritise heavily)
    failingThreshold: 8,
  },

  nodes: [
    // ── US East — Vercel ─────────────────────────────────────────────────
    {
      id: "washington",
      label: "US East (Vercel)",
      url: "https://us-r-vercel.vercel.app",
      type: "vercel",
      region: "US East",
      lbRegion: "NA",
      concurrencyLimit: null, // serverless — no hard limit
      cpuAlloc: null, // unknown (serverless)
      specs: {
        runtime: "resvg-js",
        provider: "Vercel",
        description: "Serverless — Virginia, US",
        tier: 1,
      },
      features: {
        inLbWorker: true,
        isLbFallback: false,
        inTest: true,
        apiPath: "/api/rasterize",
        supportsHealthCheck: true,
        useUrlPayload: true, // GET ?url= — no body, no poster embed needed
        acceptsCompression: false,
      },
      zones: { NA_EAST: 1, NA_WEST: 2, NA_CENTRAL: 1, SA: 3, UNKNOWN: 2 },
    },

    // ── US Central — Netlify ──────────────────────────────────────────────
    {
      id: "ohio",
      label: "US Central (Netlify)",
      url: "https://r-netlify.netlify.app",
      type: "netlify",
      region: "US",
      lbRegion: "NA",
      concurrencyLimit: null, // serverless
      cpuAlloc: null,
      specs: {
        runtime: "resvg-js",
        provider: "Netlify",
        description: "Serverless — Ohio, US",
        tier: 1,
      },
      features: {
        inLbWorker: true,
        isLbFallback: false,
        inTest: true,
        apiPath: "/api/rasterize",
        supportsHealthCheck: true,
        useUrlPayload: false,
        acceptsCompression: "gzip",
      },
      zones: { NA_EAST: 2, NA_WEST: 2, NA_CENTRAL: 1, UNKNOWN: 2 },
    },

    // ── EU — Spaceify Midas DE2 ───────────────────────────────────────────
    {
      id: "midas",
      label: "DE 2 (Midas)",
      url: "http://node-3.midas.host:25108",
      type: "spaceify",
      region: "Europe",
      lbRegion: "EU",
      concurrencyLimit: 5, // 100% CPU alloc, moderate concurrency
      cpuAlloc: 100, // 100% of whatever CPU is assigned
      specs: {
        runtime: "resvg",
        provider: "Spaceify",
        description: "Dedicated VPS — Germany (Midas)",
        tier: 1,
      },
      features: {
        inLbWorker: true,
        isLbFallback: false,
        inTest: true,
        apiPath: "",
        supportsHealthCheck: true,
        useUrlPayload: false,
        acceptsCompression: "gzip",
      },
      zones: { EU_WEST: 2, EU_CENTRAL: 1, EU_EAST: 2, UNKNOWN: 1 },
    },

    // ── EU — Spaceify Germany DE20 ────────────────────────────────────────
    {
      id: "germany",
      label: "DE 20 (Spaceify)",
      url: "http://de20.spaceify.eu:26100",
      type: "spaceify",
      region: "Europe",
      lbRegion: "EU",
      concurrencyLimit: 5,
      cpuAlloc: 90, // 90% CPU alloc
      specs: {
        runtime: "resvg",
        provider: "Spaceify",
        description: "Dedicated VPS — Germany",
        tier: 1,
      },
      features: {
        inLbWorker: true,
        isLbFallback: false,
        inTest: true,
        apiPath: "",
        supportsHealthCheck: true,
        useUrlPayload: false,
        acceptsCompression: "gzip",
      },
      zones: { EU_CENTRAL: 1, EU_EAST: 1, EU_WEST: 2, UNKNOWN: 1 },
    },

    // ── EU — DanBot Hosting ───────────────────────────────────────────────
    {
      id: "danbot",
      label: "DanBot EU",
      url: "http://dono-01.danbot.host:1751",
      type: "danbot",
      region: "Europe",
      lbRegion: "EU",
      concurrencyLimit: 8, // 200% CPU alloc; can handle more concurrent but unknown core
      cpuAlloc: 200, // 200% — likely 2 vCPUs
      specs: {
        runtime: "resvg",
        provider: "DanBot Hosting",
        description: "VPS — DanBot EU",
        tier: 1,
      },
      features: {
        inLbWorker: true,
        isLbFallback: false,
        inTest: true,
        apiPath: "",
        supportsHealthCheck: true,
        useUrlPayload: false,
        acceptsCompression: "gzip",
      },
      zones: { EU_WEST: 1, EU_CENTRAL: 1, EU_EAST: 2, UNKNOWN: 2 },
    },

    // ── Global CDN — wsrv.nl ──────────────────────────────────────────────
    // Uses URL payload (librsvg, fetches SVG from URL itself)
    {
      id: "wsrv",
      label: "wsrv.nl (CDN)",
      url: "https://wsrv.nl",
      type: "wsrv",
      region: "Global",
      lbRegion: "EU", // Primary PoP is EU but CDN is global
      concurrencyLimit: null,
      cpuAlloc: null,
      specs: {
        runtime: "librsvg",
        provider: "wsrv.nl",
        description: "Global CDN — librsvg",
        tier: 1,
      },
      features: {
        inLbWorker: true,
        isLbFallback: false,
        inTest: true,
        apiPath: "",
        supportsHealthCheck: false, // no /health endpoint
        useUrlPayload: true, // GET ?url=[svgUrl]&output=[fmt]
        acceptsCompression: false,
      },
      zones: { EU_WEST: 1, EU_CENTRAL: 1, NA_EAST: 2, NA_WEST: 2, UNKNOWN: 2 },
    },

    // ── T2 Fallback — Spaceify France ────────────────────────────────────
    {
      id: "france",
      label: "FR 1 (Spaceify)",
      url: "http://fr1.spaceify.eu:25980",
      type: "spaceify",
      region: "Europe",
      lbRegion: "EU",
      concurrencyLimit: 5,
      cpuAlloc: 90,
      specs: {
        runtime: "resvg",
        provider: "Spaceify",
        description: "Dedicated VPS — France",
        tier: 2,
      },
      features: {
        inLbWorker: false,
        isLbFallback: true, // T2 extreme fallback
        inTest: true,
        apiPath: "",
        supportsHealthCheck: true,
        useUrlPayload: false,
        acceptsCompression: "gzip",
      },
      zones: {},
    },

    // ── T2 Fallback — Render EU Central ──────────────────────────────────
    {
      id: "render_eu",
      label: "EUC (Render)",
      url: "https://euc-r-render.onrender.com",
      type: "render",
      region: "Europe",
      lbRegion: "EU",
      concurrencyLimit: null,
      cpuAlloc: null,
      specs: {
        runtime: "resvg",
        provider: "Render",
        description: "Container — EU Central",
        tier: 2,
      },
      features: {
        inLbWorker: false,
        isLbFallback: true, // T2 extreme fallback
        inTest: true,
        apiPath: "",
        supportsHealthCheck: true,
        useUrlPayload: false,
        acceptsCompression: true,
      },
      zones: {},
    },

    // ── Test-only nodes ────────────────────────────────────────────────────

    {
      id: "london",
      label: "London (Vercel)",
      url: "https://uk-r-vercel.vercel.app",
      type: "vercel",
      region: "Europe",
      lbRegion: "EU",
      concurrencyLimit: null,
      cpuAlloc: null,
      specs: {
        runtime: "resvg-js",
        provider: "Vercel",
        description: "Serverless — London, UK",
        tier: 1,
      },
      features: {
        inLbWorker: false,
        isLbFallback: false,
        inTest: true,
        apiPath: "/api/rasterize",
        supportsHealthCheck: true,
        useUrlPayload: false,
        acceptsCompression: false,
      },
      zones: {},
    },

    {
      id: "tokyo",
      label: "Tokyo (Vercel)",
      url: "https://jp-r-vercel.vercel.app",
      type: "vercel",
      region: "Asia",
      lbRegion: "NA",
      concurrencyLimit: null,
      cpuAlloc: null,
      specs: {
        runtime: "resvg-js",
        provider: "Vercel",
        description: "Serverless — Tokyo, JP",
        tier: 1,
      },
      features: {
        inLbWorker: false,
        isLbFallback: false,
        inTest: true,
        apiPath: "/api/rasterize",
        supportsHealthCheck: true,
        useUrlPayload: false,
        acceptsCompression: false,
      },
      zones: {},
    },

    {
      id: "mumbai",
      label: "Mumbai (Vercel)",
      url: "https://rasterize-node.vercel.app",
      type: "vercel",
      region: "Asia South",
      lbRegion: "NA",
      concurrencyLimit: null,
      cpuAlloc: null,
      specs: {
        runtime: "resvg-js",
        provider: "Vercel",
        description: "Serverless — Mumbai, IN",
        tier: 1,
      },
      features: {
        inLbWorker: false,
        isLbFallback: false,
        inTest: true,
        apiPath: "/api/rasterize",
        supportsHealthCheck: true,
        useUrlPayload: false,
        acceptsCompression: false,
      },
      zones: {},
    },
  ],
};
