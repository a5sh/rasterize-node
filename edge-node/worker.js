import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import fontBuffer from "../core/NotoSans-Subset.ttf";
import { processRequest } from "../core/logic.js";
import puppeteer from "@cloudflare/puppeteer";

let wasmInitialized = false;

/**
 * Find all external http(s) image hrefs in the SVG, fetch them,
 * and replace with inline base64 data URIs so resvg-wasm can render them.
 */
async function embedExternalImages(svgText) {
    const regex = /href="(https?:\/\/[^"]+)"/g;
    const matches = [...svgText.matchAll(regex)];
    if (matches.length === 0) return svgText;

    const uniqueUrls = [...new Set(matches.map(m => m[1]))];

    const replacements = await Promise.all(
        uniqueUrls.map(async (url) => {
            try {
                const res = await fetch(url, {
                    headers: { "User-Agent": "SpicyDevs-Rasterizer/2.0" },
                    signal: AbortSignal.timeout(8_000),
                });
                if (!res.ok) return { url, dataUri: null };
                const buf = await res.arrayBuffer();
                const ct = res.headers.get("content-type") || "image/jpeg";
                const bytes = new Uint8Array(buf);
                const CHUNK = 0x8000;
                let binary = "";
                for (let i = 0; i < bytes.length; i += CHUNK) {
                    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
                }
                return { url, dataUri: `data:${ct};base64,${btoa(binary)}` };
            } catch {
                return { url, dataUri: null };
            }
        })
    );

    for (const { url, dataUri } of replacements) {
        if (!dataUri) continue;
        svgText = svgText.split(`href="${url}"`).join(`href="${dataUri}"`);
    }

    return svgText;
}

/**
 * /ss route — takes a headless browser screenshot of the given URL.
 *
 * Query params:
 *   url      (required) — the page to screenshot
 *   width    (optional) — viewport width in px, default 1280
 *   height   (optional) — viewport height in px, default 720
 *   full     (optional) — "1" to capture full page, default windowed
 *   format   (optional) — "png" | "jpeg", default "png"
 *   quality  (optional) — JPEG quality 1-100, default 85 (only for jpeg)
 *   wait     (optional) — ms to wait after load before screenshot, default 0
 */
async function handleScreenshot(request, env) {
    const { searchParams } = new URL(request.url);

    const targetUrl = searchParams.get("url");
    if (!targetUrl) {
        return new Response(JSON.stringify({ error: 'Missing required ?url= parameter' }), {
            status: 400,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
    }

    // Validate the URL is well-formed before launching a browser
    let parsedUrl;
    try {
        parsedUrl = new URL(targetUrl);
        if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("bad protocol");
    } catch {
        return new Response(JSON.stringify({ error: "Invalid URL — must be http or https" }), {
            status: 400,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
    }

    const width    = Math.min(Math.max(parseInt(searchParams.get("width")  || "1280", 10), 320), 3840);
    const height   = Math.min(Math.max(parseInt(searchParams.get("height") || "720",  10), 240), 2160);
    const fullPage = searchParams.get("full") === "1";
    const format   = searchParams.get("format") === "jpeg" ? "jpeg" : "png";
    const quality  = Math.min(Math.max(parseInt(searchParams.get("quality") || "85", 10), 1), 100);
    const waitMs   = Math.min(Math.max(parseInt(searchParams.get("wait")    || "0",  10), 0), 10_000);

    let browser;
    try {
        browser = await puppeteer.launch(env.MYBROWSER);
        const page = await browser.newPage();

        await page.setViewport({ width, height });

        // Block ads/trackers to speed up load and reduce noise
        await page.setRequestInterception(true);
        page.on("request", (req) => {
            const blocked = ["doubleclick.net", "googlesyndication.com", "adservice.google.com"];
            if (blocked.some(h => req.url().includes(h))) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.goto(parsedUrl.toString(), {
            waitUntil: "networkidle2",
            timeout: 25_000,
        });

        // Optional extra wait (e.g. for JS-driven animations)
        if (waitMs > 0) {
            await new Promise(r => setTimeout(r, waitMs));
        }

        const screenshotOpts = {
            type: format,
            fullPage,
            ...(format === "jpeg" ? { quality } : {}),
        };

        const imageBuffer = await page.screenshot(screenshotOpts);

        return new Response(imageBuffer, {
            status: 200,
            headers: {
                "Content-Type": format === "jpeg" ? "image/jpeg" : "image/png",
                "Cache-Control": "public, max-age=3600",
                "Access-Control-Allow-Origin": "*",
                "X-Screenshot-URL": parsedUrl.toString(),
            },
        });

    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error("[/ss] screenshot error:", msg, error?.stack || "");
        return new Response(JSON.stringify({ error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
    } finally {
        // Always close the browser — leaking sessions counts against your quota
        if (browser) await browser.close();
    }
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // ── Screenshot route ────────────────────────────────────────────────
        if (url.pathname === "/ss") {
            return handleScreenshot(request, env);
        }

        // ── Existing SVG rasterization routes ──────────────────────────────
        if (!wasmInitialized) {
            await initWasm(resvgWasm);
            wasmInitialized = true;
        }

        const getBodyText = async () => await request.text();
        const processed = await processRequest(
            request.url, request.method, request.headers, getBodyText, env
        );

        if (processed.status !== 200 || !processed.svgText) {
            return new Response(processed.body, {
                status: processed.status,
                headers: {
                    "Content-Type": processed.contentType || "text/plain",
                    "Access-Control-Allow-Origin": "*",
                }
            });
        }

        try {
            const svgText = await embedExternalImages(processed.svgText);

            const resvgOpts = {
                fitTo: { mode: "original" },
                font: {
                    loadSystemFonts: false,
                    defaultFontFamily: "Noto Sans",
                },
                imageRendering: 1,
            };
            resvgOpts.font.fontBuffers = [new Uint8Array(fontBuffer)];

            const resvg = new Resvg(svgText, resvgOpts);
            const pngBuffer = resvg.render().asPng();

            const response = new Response(pngBuffer, {
                status: 200,
                headers: {
                    "Content-Type": "image/png",
                    "Cache-Control": "public, max-age=86400",
                    "Access-Control-Allow-Origin": "*",
                }
            });

            if (request.method === "GET") {
                ctx.waitUntil(caches.default.put(request, response.clone()));
            }
            return response;

        } catch (error) {
            const msg = error instanceof Error
                ? error.message
                : (typeof error === "string" ? error : JSON.stringify(error));
            console.error("[rasterize] render error:", msg, error?.stack || "");
            return new Response(JSON.stringify({ error: msg }), {
                status: 500,
                headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*",
                }
            });
        }
    }
};