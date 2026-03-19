import http from 'node:http';
import { Resvg } from '@resvg/resvg-js';
import { processRequest } from '../core/logic.js';

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        return res.end();
    }

   try {
        const reqUrl = `http://${req.headers.host}${req.url}`;
        const getBodyText = () => new Promise((resolve) => {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', () => resolve(body));
        });

        // ── Bulk Processing Path ──────────────────────────────────────────
        if (req.headers['content-type'] === 'application/json') {
            const bodyStr = await getBodyText();
            const payload = JSON.parse(bodyStr);
            
            if (!Array.isArray(payload.jobs)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: "Expected JSON object with a 'jobs' array" }));
            }

            // Process all jobs concurrently using the Rust thread pool
            const results = await Promise.all(payload.jobs.map(async (job) => {
                try {
                    const resvg = new Resvg(job.svgText, {
                        fitTo: { mode: "original" },
                        font: { loadSystemFonts: true },
                        imageRendering: 0
                    });

                    const format = job.format || 'png';
                    let buffer;
                    let mimeType = 'image/png';

                    if ((format === 'jpg' || format === 'jpeg') && typeof resvg.render().asJpeg === 'function') {
                        buffer = resvg.render().asJpeg(85);
                        mimeType = 'image/jpeg';
                    } else if (format === 'webp' && typeof resvg.render().asWebp === 'function') {
                        buffer = resvg.render().asWebp(85);
                        mimeType = 'image/webp';
                    } else {
                        buffer = resvg.render().asPng();
                    }

                    return { 
                        id: job.id, 
                        status: 'success', 
                        mimeType, 
                        data: buffer.toString('base64') 
                    };
                } catch (err) {
                    return { id: job.id, status: 'error', error: err.message };
                }
            }));

            res.writeHead(200, { 
                'Content-Type': 'application/json', 
                'Cache-Control': 'no-store' // Do not cache dynamic bulk responses
            });
            return res.end(JSON.stringify({ results }));
        }

        // ── Single Processing Path (Legacy) ───────────────────────────────
        const processed = await processRequest(reqUrl, req.method, req.headers, getBodyText, process.env);

        if (processed.status !== 200 || !processed.svgText) {
            res.writeHead(processed.status, { 'Content-Type': processed.contentType || 'text/plain' });
            return res.end(processed.body);
        }

        const resvg = new Resvg(processed.svgText, {
            fitTo: { mode: "original" },
            font: { loadSystemFonts: true },
            imageRendering: 0
        });

        const urlObj = new URL(reqUrl);
        const formatQuery = urlObj.searchParams.get('format') || 'png';
        
        let outputBuffer;
        let mimeType = 'image/png';

        if ((formatQuery === 'jpg' || formatQuery === 'jpeg') && typeof resvg.render().asJpeg === 'function') {
            outputBuffer = resvg.render().asJpeg(85);
            mimeType = 'image/jpeg';
        } else if (formatQuery === 'webp' && typeof resvg.render().asWebp === 'function') {
             outputBuffer = resvg.render().asWebp(85);
             mimeType = 'image/webp';
        } else {
            outputBuffer = resvg.render().asPng();
        }

        res.writeHead(200, {
            'Content-Type': mimeType,
            'Cache-Control': 'public, max-age=86400'
        });
        res.end(outputBuffer);

    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
    }});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Native Rasterizer running on port ${PORT}`);
});