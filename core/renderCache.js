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
