// assets/nodes.config.js
//
// Central raster node registry.  Used by:
//   api/routes/test.js      — test comparison page
//   api/routes/b2p.js       — French node URL
//   cloudflare/worker.js    — T1 pool and EUC fallback derivation
//
// FIELD GUIDE
// ───────────
// features.inBalancer    — legacy (rasterBalancer.js deleted); keep for docs
// features.inLbWorker    — included in CF sub-worker's T1 load-balancer pool
// features.isLbFallback  — used as EUC last-resort in CF sub-worker
// features.inTest        — shown in /test comparison page
// lbRegion               — 'NA' | 'EU' used by CF sub-worker for geo routing

export default {
  settings: {
    // ── CF sub-worker tunables ────────────────────────────────────────────
    t1TimeoutMs: 5_000, // per-T1-node attempt timeout
    eucTimeoutMs: 10_000, // EUC last-resort timeout
    wsrvTimeoutMs: 5_000, // wsrv.nl timeout
    staggerMs: [0, 1_500, 2_500], // stagger delays for T1 race
    enableWsrv: true, // include wsrv.nl in fallback chain

    // ── Legacy (rasterBalancer.js deleted) ────────────────────────────────
    nodeTimeoutMs: 4_000,
    vercelWindowMs: 60_000,
    vercelWindowLimit: 400,
    wsrvUseEveryN: 7,
    defaultTierTimeoutMs: 6_500,
    queueDepthStalenessMs: 30_000,
    disableSimpleBinding: false,
    disabledNodes: [],
  },

  nodes: [
    // ── US East — Vercel (URL-payload, no fast-origin cost) ───────────────
    {
      id: "washington",
      label: "US East",
      url: "https://us-r-vercel.vercel.app",
      type: "vercel",
      region: "US East",
      lbRegion: "NA",
      concurrencyLimit: null,
      specs: {
        runtime: "resvg-js",
        provider: "Vercel Edge",
        description: "Serverless — Virginia, US",
        tier: 1,
      },
      features: {
        inBalancer: true, // legacy
        inLbWorker: true, // CF sub-worker T1 pool
        isLbFallback: false,
        inTest: true,
        apiPath: "/api/rasterize",
        supportsHealthCheck: true,
        useUrlPayload: true, // GET ?url= path
        acceptsCompression: false,
      },
      zones: {
        NA_EAST: 1,
        NA_WEST: 1,
        NA_CENTRAL: 1,
        SA: 2,
        UNKNOWN: 2,
      },
    },

    // ── London — TEST ONLY ────────────────────────────────────────────────
    {
      id: "london",
      label: "London",
      url: "https://uk-r-vercel.vercel.app",
      type: "vercel",
      region: "Europe",
      lbRegion: "EU",
      concurrencyLimit: null,
      specs: {
        runtime: "resvg-js",
        provider: "Vercel Edge",
        description: "Serverless — London, UK",
        tier: 1,
      },
      features: {
        inBalancer: false,
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

    // ── Tokyo — TEST ONLY ─────────────────────────────────────────────────
    {
      id: "tokyo",
      label: "Tokyo",
      url: "https://jp-r-vercel.vercel.app",
      type: "vercel",
      region: "Asia",
      lbRegion: "NA",
      concurrencyLimit: null,
      specs: {
        runtime: "resvg-js",
        provider: "Vercel Edge",
        description: "Serverless — Tokyo, JP",
        tier: 1,
      },
      features: {
        inBalancer: false,
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

    // ── Mumbai — TEST ONLY ────────────────────────────────────────────────
    {
      id: "mumbai",
      label: "Mumbai",
      url: "https://rasterize-node.vercel.app",
      type: "vercel",
      region: "Asia South",
      lbRegion: "NA",
      concurrencyLimit: null,
      specs: {
        runtime: "resvg-js",
        provider: "Vercel Edge",
        description: "Serverless — Mumbai, IN",
        tier: 1,
      },
      features: {
        inBalancer: false,
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

    // ── Netlify — Ohio ────────────────────────────────────────────────────
    {
      id: "ohio",
      label: "Ohio",
      url: "https://r-netlify.netlify.app",
      type: "netlify",
      region: "US",
      lbRegion: "NA",
      concurrencyLimit: null,
      specs: {
        runtime: "resvg-js",
        provider: "Netlify Edge",
        description: "Serverless — Ohio, US",
        tier: 1,
      },
      features: {
        inBalancer: true, // legacy
        inLbWorker: false, // not currently in CF sub-worker pool
        isLbFallback: false,
        inTest: true,
        apiPath: "/api/rasterize",
        supportsHealthCheck: true,
        useUrlPayload: false,
        acceptsCompression: true,
      },
      zones: {},
    },

    // ── Spaceify — Midas DE2 (T1 EU primary) ─────────────────────────────
    {
      id: "midas",
      label: "DE 2",
      url: "http://node-3.midas.host:25108",
      type: "spaceify",
      region: "Europe",
      lbRegion: "EU",
      concurrencyLimit: 5,
      specs: {
        runtime: "resvg",
        provider: "Spaceify",
        description: "Dedicated VPS — Germany Midas",
        tier: 1,
      },
      features: {
        inBalancer: true,
        inLbWorker: true, // CF sub-worker T1 pool
        isLbFallback: false,
        inTest: true,
        apiPath: "",
        supportsHealthCheck: true,
        useUrlPayload: false,
        acceptsCompression: true,
      },
      zones: {
        EU_WEST: 2,
        EU_CENTRAL: 2,
        UNKNOWN: 1,
      },
    },

    // ── Spaceify — Germany DE20 (T1 EU secondary) ─────────────────────────
    {
      id: "germany",
      label: "DE 20",
      url: "http://de20.spaceify.eu:26100",
      type: "spaceify",
      region: "Europe",
      lbRegion: "EU",
      concurrencyLimit: 5,
      specs: {
        runtime: "resvg",
        provider: "Spaceify",
        description: "Dedicated VPS — Germany",
        tier: 2,
      },
      features: {
        inBalancer: false, // legacy field; removed from old balancer for quota
        inLbWorker: true, // CF sub-worker T1 pool
        isLbFallback: false,
        inTest: true,
        apiPath: "",
        supportsHealthCheck: true,
        useUrlPayload: false,
        acceptsCompression: true,
      },
      zones: {
        EU_CENTRAL: 1,
        EU_EAST: 1,
        EU_WEST: 2,
        UNKNOWN: 1,
      },
    },

    // ── Render — EU Central (EUC last-resort fallback) ────────────────────
    {
      id: "render_eu",
      label: "EUC",
      url: "https://euc-r-render.onrender.com",
      type: "render",
      region: "Europe",
      lbRegion: "EU",
      concurrencyLimit: null,
      specs: {
        runtime: "resvg",
        provider: "Render",
        description: "Container — EU Central",
        tier: 3,
      },
      features: {
        inBalancer: true,
        inLbWorker: false, // not T1; used as EUC fallback only
        isLbFallback: true, // CF sub-worker last-resort
        inTest: true,
        apiPath: "",
        supportsHealthCheck: true,
        useUrlPayload: false,
        acceptsCompression: true,
      },
      zones: {
        EU_WEST: 3,
        EU_CENTRAL: 2,
        ME_AF: 3,
        UNKNOWN: 3,
      },
    },
  ],
};
