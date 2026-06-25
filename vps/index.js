// vps/index.js
//
// Pterodactyl entry point — auto-fetches latest code from GitHub before starting.
//
// ENV VARS:
//   GITHUB_REPO    REQUIRED  — "owner/repo" (e.g. "aayu5h/posterium-backend")
//   GITHUB_BRANCH  optional  — default "main"
//   GITHUB_TOKEN   optional  — personal access token for private repos
//   SKIP_UPDATE    optional  — set to "1" to skip update check (debug)
//
// On every restart: fetch latest SHA → compare → sync changed files → start server.js
// No child processes. On restart Node clears the module cache, so fresh imports work.

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, ".."); // repo root — vps/ is one level down

// ── Config ────────────────────────────────────────────────────────────────────

const REPO = process.env.GITHUB_REPO || "a5sh/rasterize-node";
const BRANCH = process.env.GITHUB_BRANCH || "main";
const TOKEN = process.env.GITHUB_TOKEN || "";
const SKIP_UPDATE = process.env.SKIP_UPDATE === "1";

// AFTER
const GH_RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
const GH_API = `https://api.github.com/repos/${REPO}/commits/${BRANCH}`;
const VERSION_FILE = join(__dir, ".version");

// Files to sync on each restart.
// Format: [localPath relative to ROOT, path in repo]
// Core files (../core from vps/) are preferred by lib.js resolver over ./lib/ copies.
const SYNC_FILES = [
  // VPS-specific
  ["vps/server.js", "vps/server.js"],
  ["vps/discord.js", "vps/discord.js"],
  ["vps/lib.js", "vps/lib.js"],
  // Core shared modules
  ["core/renderPool.js", "core/renderPool.js"],
  ["core/renderWorker.js", "core/renderWorker.js"],
  ["core/sharedRender.js", "core/sharedRender.js"],
  ["core/fauxBold.js", "core/fauxBold.js"],
  ["core/cache.js", "core/cache.js"],
  ["core/iconCache.js", "core/iconCache.js"],
  ["core/b2p.js", "core/b2p.js"],
  ["core/embedImages.js", "core/embedImages.js"],
  // Node registry (concurrency limits, feature flags, etc.)
  ["assets/nodes.config.js", "assets/nodes.config.js"],
];

// ── GitHub helpers ────────────────────────────────────────────────────────────

function ghHeaders() {
  const h = {
    "User-Agent": "Posterium-VPS-Updater/1.0",
    Accept: "application/vnd.github.v3+json",
  };
  if (TOKEN) h["Authorization"] = `token ${TOKEN}`;
  return h;
}

async function getLatestSha() {
  const res = await fetch(GH_API, {
    headers: ghHeaders(),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok)
    throw new Error(
      `GitHub API returned ${res.status} — check GITHUB_TOKEN if repo is private`,
    );
  const data = await res.json();
  if (!data.sha) throw new Error("No sha in GitHub response");
  return data.sha;
}

async function readStoredSha() {
  try {
    return (await readFile(VERSION_FILE, "utf8")).trim();
  } catch {
    return null;
  }
}

async function downloadFile(repoPath) {
  const url = `${GH_RAW}/${repoPath}`;
  const res = await fetch(url, {
    headers: ghHeaders(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${repoPath}`);
  return res.text();
}

async function syncAllFiles(sha) {
  let ok = 0,
    fail = 0;

  for (const [localRel, repoPath] of SYNC_FILES) {
    const dest = join(ROOT, localRel);
    const dir = dirname(dest);
    try {
      if (!existsSync(dir)) await mkdir(dir, { recursive: true });
      const content = await downloadFile(repoPath);
      await writeFile(dest, content, "utf8");
      ok++;
      process.stdout.write(`[updater] ✓  ${repoPath}\n`);
    } catch (e) {
      fail++;
      process.stderr.write(`[updater] ✗  ${repoPath} — ${e.message}\n`);
    }
  }

  // Only record the new SHA if every file succeeded
  if (fail === 0) {
    await writeFile(VERSION_FILE, sha, "utf8");
  } else {
    process.stderr.write(
      `[updater] ${fail} file(s) failed — version file NOT updated (will retry next restart)\n`,
    );
  }

  return { ok, fail };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const banner = `═══════════════════════════════════════
  Posterium VPS  |  ${new Date().toISOString()}
  Repo: ${REPO || "(GITHUB_REPO not set)"}@${BRANCH}
═══════════════════════════════════════`;
  console.log(banner);

  if (!REPO) {
    console.warn(
      "[updater] GITHUB_REPO not configured — starting with existing files",
    );
  } else if (SKIP_UPDATE) {
    console.log("[updater] SKIP_UPDATE=1 — skipping auto-update");
  } else {
    try {
      const stored = await readStoredSha();
      const latest = await getLatestSha();
      const shortStored = stored ? stored.slice(0, 7) : "none";
      const shortLatest = latest.slice(0, 7);

      if (stored === latest) {
        console.log(`[updater] ✓ Already at latest  (${shortLatest})`);
      } else {
        console.log(
          `[updater] Update available: ${shortStored} → ${shortLatest}`,
        );
        const t0 = Date.now();
        const { ok, fail } = await syncAllFiles(latest);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(
          `[updater] Sync complete in ${elapsed}s — ${ok} updated, ${fail} failed`,
        );
      }
    } catch (e) {
      console.error(`[updater] Update check failed: ${e.message}`);
      console.warn("[updater] Starting with existing files on disk");
    }
  }

  // Log the actual running version for clear restart confirmation in Pterodactyl console
  const runSha = await readStoredSha().catch(() => "unknown");
  console.log(
    `\n[updater] ► Starting server  version=${runSha?.slice(0, 7) ?? "unknown"}\n`,
  );

  // Dynamic import — module cache is always cold on process restart,
  // so this always loads the freshly-written server.js from disk.
  try {
    await import("./server.js");
  } catch (e) {
    console.error("[updater] server.js failed to start:", e);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[updater] Fatal:", e);
  process.exit(1);
});
