export function simpleHash(str) {
  // Full-string FNV-1a. The earlier windowed variant (first 4096 chars + last
  // 64) COLLIDED for POST bodies: the icon <defs> block dominates the head and
  // closing tags the tail, so different posters hashed to the same key and the
  // cache served the wrong render. FNV over the whole string is O(n) and costs
  // microseconds even on a 60KB b64-embedded SVG — correctness over micro-opts.
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function makeCacheKey(svgText, format, queryParts = null) {
  // GET requests (Vercel/Netlify URL-payload path) carry query params — hash a
  // JSON of those instead of the raw SVG: same url + format ⇒ same render ⇒
  // same key, immune to b64 byte drift. POST bodies have no queries and are
  // fully content-addressed (whole-SVG hash, see simpleHash).
  const seed = queryParts ? JSON.stringify(queryParts) : svgText;
  return simpleHash(seed) + ":" + format;
}

export function createRenderCache(options = {}) {
  const envMb = parseInt(process.env.RENDER_CACHE_MB || "50", 10);
  const maxBytes = options.maxSize || envMb * 1024 * 1024;
  const entryTtl = options.ttl || 3 * 60_000;
  const maxEntryBytes = options.maxEntrySize || 10 * 1024 * 1024;

  const _map = new Map();
  let _head = null;
  let _tail = null;
  let _totalBytes = 0;

  function _sizeOf(value) {
    return value.buffer.byteLength + value.key.length;
  }

  function _removeNode(node) {
    if (node.prev) node.prev.next = node.next;
    else _head = node.next;
    if (node.next) node.next.prev = node.prev;
    else _tail = node.prev;
  }

  function _prepend(node) {
    node.next = _head;
    node.prev = null;
    if (_head) _head.prev = node;
    _head = node;
    if (!_tail) _tail = node;
  }

  function _evictLru() {
    while (_totalBytes > maxBytes && _tail) {
      const entry = _map.get(_tail.key);
      if (entry) {
        _map.delete(_tail.key);
        _totalBytes -= entry.bytes;
      }
      _tail = _tail.prev;
      if (_tail) _tail.next = null;
      else _head = null;
    }
  }

  function _refresh(key) {
    const entry = _map.get(key);
    if (!entry) return null;
    if (entry.expiry && Date.now() > entry.expiry) {
      _removeNode(entry.node);
      _map.delete(key);
      _totalBytes -= entry.bytes;
      return null;
    }
    _removeNode(entry.node);
    _prepend(entry.node);
    return entry;
  }

  return {
    get(key) {
      const entry = _refresh(key);
      return entry ? entry.value : undefined;
    },

    set(key, value) {
      const entryBytes = _sizeOf(value);
      if (entryBytes > maxEntryBytes) return;

      const existing = _map.get(key);
      if (existing) {
        _totalBytes -= existing.bytes;
        _removeNode(existing.node);
      }

      const node = { key, prev: null, next: null };
      const data = {
        value,
        bytes: entryBytes,
        expiry: Date.now() + entryTtl,
        node,
      };

      _map.set(key, data);
      _totalBytes += entryBytes;
      _prepend(node);

      if (_totalBytes > maxBytes) _evictLru();
    },

    get size() {
      return _map.size;
    },
  };
}
