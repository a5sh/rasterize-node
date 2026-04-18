// core/b2p.js
import sharp from 'sharp';

const _b2pCache = new Map();
const CACHE_TTL = 10 * 60_000; // 10 minutes
const MAX_CACHE = 100;

/**
 * Fetches a backdrop URL, smartly crops it to 500x750 (2:3 aspect ratio),
 * and caches the output buffer in memory for instant subsequent retrievals.
 */
export async function generatePosterFromBackdrop(imageUrl, format = 'jpeg') {
  const cacheKey = `${imageUrl}-${format}`;
  const cached = _b2pCache.get(cacheKey);
  
  if (cached && Date.now() < cached.expiry) {
    return { buffer: cached.buffer, mimeType: cached.mimeType };
  }

  // 1. Fetch the backdrop with a strict timeout to prevent hanging the event loop
  const imgRes = await fetch(imageUrl, {
    signal: AbortSignal.timeout(5000),
    headers: { 'User-Agent': 'SpicyDevs-Rasterizer/4.0' }
  });
  
  if (!imgRes.ok) {
    throw new Error(`Backdrop fetch failed with status: ${imgRes.status}`);
  }

  const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
  const outputFormat = format === 'png' ? 'png' : format === 'webp' ? 'webp' : 'jpeg';

  // 2. Process via sharp using attention-based smart cropping
   const buffer = await sharp(imgBuffer)
    .resize({
      width: 500,
      height: 750,
      fit: sharp.fit.cover,
      position: sharp.strategy.attention,
      // withoutEnlargement intentionally removed:
      // small backdrops (< 750px tall) must be upscaled to fill 500×750.
    })
    .toFormat(outputFormat, { quality: 85 })
    // progressive: true removed — interlaced JPEG renders scan lines
    // top-to-bottom in browsers, which looks broken for on-the-fly output.
    .toBuffer();
  const result = { buffer, mimeType: `image/${outputFormat}` };

  // 3. Update LRU Cache
  if (_b2pCache.size >= MAX_CACHE) {
    _b2pCache.delete(_b2pCache.keys().next().value);
  }
  _b2pCache.set(cacheKey, { ...result, expiry: Date.now() + CACHE_TTL });

  return result;
}