// scripts/build.mjs
//
// Copies shared core/ files into {platform}/lib/ so each platform's
// rasterizer handler can import them at runtime.
//
// Usage:
//   node scripts/build.mjs vercel
//   node scripts/build.mjs netlify
//   node scripts/build.mjs render
//   node scripts/build.mjs vps
//
// Called automatically by each platform's build command:
//   vercel.json  → "buildCommand": "node ../scripts/build.mjs vercel"
//   netlify.toml → command = "npm install && node ../scripts/build.mjs netlify"
//   render.yaml  → buildCommand: "npm install && node ../scripts/build.mjs render"
//   package.json → "prestart": "node ../scripts/build.mjs vps"

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Resolve paths ─────────────────────────────────────────────────────────────

const __dir     = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dir, '..');   // scripts/ is one level below root
const CORE_DIR  = path.join(REPO_ROOT, 'core');

// Files copied into every platform's lib/
const CORE_FILES = [
  'fauxBold.js',
  'sharedRender.js',
  'renderPool.js',
  'renderWorker.js',
  'iconCache.js',   // ← add this
  'NotoSans-Subset.ttf',
  'b2p.js',
  'cache.js',
];

// ── CLI arg ───────────────────────────────────────────────────────────────────

const platform = process.argv[2];
const SUPPORTED = ['vercel', 'netlify', 'render', 'vps'];

if (!platform || !SUPPORTED.includes(platform)) {
  console.error(`Usage: node scripts/build.mjs <${SUPPORTED.join('|')}>`);
  process.exit(1);
}

// ── Destination ───────────────────────────────────────────────────────────────

// When invoked from within the platform directory (e.g. `cd vercel && npm run build`)
// the cwd is the platform dir, so REPO_ROOT/../{platform}/lib works.
// When invoked from repo root (e.g. CI), path is repo_root/{platform}/lib.
// We resolve relative to REPO_ROOT so both cases work.
const DEST_DIR = path.join(REPO_ROOT, platform, 'lib');

// ── Copy ──────────────────────────────────────────────────────────────────────

fs.mkdirSync(DEST_DIR, { recursive: true });

let copied = 0;
let skipped = 0;

for (const file of CORE_FILES) {
  const src = path.join(CORE_DIR, file);

  if (!fs.existsSync(src)) {
    console.warn(`[build] WARNING: core/${file} not found — skipping`);
    skipped++;
    continue;
  }

  const dest = path.join(DEST_DIR, file);
  fs.copyFileSync(src, dest);
  console.log(`[build] ${file} → ${platform}/lib/${file}`);
  copied++;
}

console.log(`[build] Done. ${copied} file(s) copied to ${platform}/lib/${skipped > 0 ? ` (${skipped} skipped)` : ''}`);

// Verify the critical JS files are present
const REQUIRED = ['fauxBold.js', 'sharedRender.js'];
for (const f of REQUIRED) {
  const p = path.join(DEST_DIR, f);
  if (!fs.existsSync(p)) {
    console.error(`[build] FATAL: ${f} missing from ${platform}/lib/ — build will fail at runtime`);
    process.exit(1);
  }
}