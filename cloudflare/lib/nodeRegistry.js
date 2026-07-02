// cloudflare/lib/nodeRegistry.js
//
// Derives the T1 (primary race pool) and T2 (extreme fallback) node views
// from the central assets/nodes.config.js registry, plus the tunable
// timing/threshold settings. Kept local to Worker B (rasterize) — Worker A
// (posterium-backend/api/routes/test.js) derives its own view for its own
// benchmark page. Unifying the two into one shared view module across two
// separately-deployed Workers is a larger change, tracked separately.

import NODE_CONFIG from "../../assets/nodes.config.js";

export const T1_NODES = NODE_CONFIG.nodes
  .filter((n) => n.features.inLbWorker)
  .sort((a, b) => (a.specs.tier ?? 99) - (b.specs.tier ?? 99))
  .map((n) => ({
    id: n.id,
    type: n.type,
    baseUrl: n.url, // health check URL (no apiPath)
    url: `${n.url}${n.features.apiPath ?? ""}`, // raster POST/GET URL
    lbRegion: n.lbRegion,
    concurrencyLimit: n.concurrencyLimit ?? null,
    useUrlPayload: n.features.useUrlPayload ?? false,
    acceptsCompression: n.features.acceptsCompression ?? false, // 'gzip' | 'br' | false
    supportsHealthCheck: n.features.supportsHealthCheck ?? false,
  }));

export const T2_NODES = NODE_CONFIG.nodes
  .filter((n) => n.features.isLbFallback)
  .map((n) => ({
    id: n.id,
    type: n.type,
    baseUrl: n.url,
    url: `${n.url}${n.features.apiPath ?? ""}`,
    lbRegion: n.lbRegion,
    concurrencyLimit: n.concurrencyLimit ?? null,
    useUrlPayload: false,
    acceptsCompression: n.features.acceptsCompression ?? false,
    supportsHealthCheck: n.features.supportsHealthCheck ?? false,
  }));

export const SETTINGS = {
  t1TimeoutMs: NODE_CONFIG.settings.t1TimeoutMs ?? 5_000,
  t2TimeoutMs: NODE_CONFIG.settings.t2TimeoutMs ?? 8_000,
  posterEmbedTimeoutMs: NODE_CONFIG.settings.posterEmbedTimeoutMs ?? 6_000,
  maxWallTimeMs: NODE_CONFIG.settings.maxWallTimeMs ?? 7_000,
  stressThreshold: NODE_CONFIG.settings.stressThreshold ?? 3,
  failingThreshold: NODE_CONFIG.settings.failingThreshold ?? 8,
  errWindowMs: NODE_CONFIG.settings.errWindowMs ?? 60_000,
};
