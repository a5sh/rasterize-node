const ALLOWED_HOSTS = ["api.spicydevs.xyz", "posters.spicydevs.xyz", "rpdb.padhaiaayush.workers.dev"];

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

    return { status: 200, svgText };
}