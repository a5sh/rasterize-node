import { LRUCache } from "lru-cache";

export function simpleHash(str) {
  let h = 0x811c9dc5;
  const len = Math.min(str.length, 4096);
  for (let i = 0; i < len; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const tail = str.length > 4096 ? str.slice(-64) : "";
  for (let i = 0; i < tail.length; i++) {
    h ^= tail.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function makeCacheKey(svgText, format) {
  return simpleHash(svgText) + ":" + format;
}

export function createRenderCache(options = {}) {
  const maxMb = parseInt(process.env.RENDER_CACHE_MB || "50", 10);
  return new LRUCache({
    maxSize: maxMb * 1024 * 1024,
    sizeCalculation: (value) => value.buffer.byteLength + value.key.length,
    ttl: 3 * 60_000,
    maxEntrySize: 10 * 1024 * 1024,
    ...options,
  });
}
