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

        const pngBuffer = resvg.render().asPng();

        res.writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=86400'
        });
        res.end(pngBuffer);

    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Native Rasterizer running on port ${PORT}`);
});