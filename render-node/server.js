import http from 'node:http';
import { Resvg } from '@resvg/resvg-js'; // Native C++ Binding
import { processRequest } from '../core/logic.js';

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
    // ... [Same HTTP parsing logic as provided previously] ...
    
    const reqUrl = `http://${req.headers.host}${req.url}`;
    const getBodyText = () => new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => resolve(body));
    });

    const processed = await processRequest(reqUrl, req.method, req.headers, getBodyText, process.env);

    if (processed.status !== 200 || !processed.svgText) {
        res.writeHead(processed.status);
        return res.end(processed.body);
    }

    // Executes natively at C++ speeds. No WASM compilation. No cold starts.
    const resvg = new Resvg(processed.svgText, {
        fitTo: { mode: "original" },
        font: { loadSystemFonts: true },
        imageRendering: 0 // optimizeSpeed
    });

    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    res.end(resvg.render().asPng());
});

server.listen(PORT, '0.0.0.0');