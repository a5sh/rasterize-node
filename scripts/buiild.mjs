#!/usr/bin/env node
// scripts/build.mjs
//
// Copies shared core/ files into {platform}/lib/ so that each platform
// folder is self-contained and can be set as the deployment root.
//
// Usage:
//   node scripts/build.mjs              # copies to all platforms
//   node scripts/build.mjs netlify      # copies to netlify/lib/ only
//   node scripts/build.mjs vercel render vps
//
// Cloudflare is intentionally excluded — wrangler bundles imports from
// ../core/ directly and does not need a lib/ copy.

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const CORE_DIR  = path.join(ROOT, 'core');

// Files copied into every platform's lib/
const CORE_FILES = [
  'fauxBold.js',
  'sharedRender.js',
  'renderPool.js',
  'renderWorker.js',
  'NotoSans-Subset.ttf',
];

// Platforms that use lib/ (cloudflare handled separately by wrangler)
const ALL_PLATFORMS = ['netlify', 'vercel', 'render', 'vps'];

// ── CLI args ──────────────────────────────────────────────────────────────────

const args     = process.argv.slice(2).filter(a => !a.startsWith('-'));
const targets  = args.length ? args : ALL_PLATFORMS;
const unknown  = targets.filter(t => !ALL_PLATFORMS.includes(t));

if (unknown.length) {
  console.error(`[build] Unknown platform(s): ${unknown.join(', ')}`);
  console.error(`[build] Valid: ${ALL_PLATFORMS.join(', ')}`);
  process.exit(1);
}

// ── Copy ──────────────────────────────────────────────────────────────────────

let ok = true;

for (const platform of targets) {
  const libDir = path.join(ROOT, platform, 'lib');

  try {
    fs.mkdirSync(libDir, { recursive: true });
  } catch (e) {
    console.error(`[build] Cannot create ${libDir}: ${e.message}`);
    ok = false;
    continue;
  }

  for (const file of CORE_FILES) {
    const src = path.join(CORE_DIR, file);
    const dst = path.join(libDir, file);

    if (!fs.existsSync(src)) {
      // NotoSans-Subset.ttf might not be in the repo during CI; warn but continue.
      if (file.endsWith('.ttf')) {
        console.warn(`[build] WARNING: ${src} not found — font will be missing in ${platform}`);
      } else {
        console.error(`[build] MISSING: ${src}`);
        ok = false;
      }
      continue;
    }

    fs.copyFileSync(src, dst);
  }

  const copied = CORE_FILES.filter(f => fs.existsSync(path.join(libDir, f)));
  console.log(`[build] ${platform}/lib/  ← ${copied.join(', ')}`);
}

if (!ok) process.exit(1);