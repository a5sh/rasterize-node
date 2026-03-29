const ALLOWED_HOSTS = ["api.spicydevs.xyz", "posters.spicydevs.xyz", "rpdb.padhaiaayush.workers.dev"];

// core/logic.js
export async function processRequest(reqUrl, method, headers, getBodyText, env) {
    const url = new URL(reqUrl);

    if (url.pathname === "/health") {
        return { status: 200, body: JSON.stringify({ status: "ok", version: "2.0" }), contentType: "application/json" };
    }

    let svgText = "";

    if (method === "POST") {
        svgText = await getBodyText();
        if (!svgText) return { status: 400, body: "Empty SVG body", contentType: "text/plain" };
    } 
    else if (method === "GET") {
        const targetSvgUrl = url.searchParams.get("url");
        if (!targetSvgUrl) return { status: 400, body: "Missing ?url= parameter", contentType: "text/plain" };

        const targetUrlObj = new URL(targetSvgUrl);
        const svgRes = await fetch(targetSvgUrl, { headers: { "User-Agent": "SpicyDevs-Rasterizer/2.0" } });
        if (!svgRes.ok) throw new Error(`SVG fetch failed: ${svgRes.status}`);
        svgText = await svgRes.text();
    } else {
        return { status: 405, body: "Method not allowed", contentType: "text/plain" };
    }

    // --- NEW: Faux Bold Synthesis ---
    // Safely parse text tags requesting bold weights (600-900 or 'bold')
    svgText = svgText.replace(
        /(<text[^>]*?)(>.*?<\/text>)/gi,
        (match, openingTag, innerText) => {
            const isBold = /font-weight=["']?(bold|bolder|[6-9]00)["']?/i.test(openingTag);
            if (!isBold) return match;

            // Extract the fill color to use as the stroke color
            const fillMatch = openingTag.match(/fill=["']([^"']+)["']/i);
            
            // Apply stroke if fill exists and stroke isn't already defined
            if (fillMatch && !openingTag.includes('stroke=')) {
                const fillStr = fillMatch[1];
                // stroke-linejoin="round" is critical to prevent sharp artifacts on text corners
                openingTag += ` stroke="${fillStr}" stroke-width="1.5" stroke-linejoin="round"`;
            }
            return openingTag + innerText;
        }
    );

    return { status: 200, svgText };
}