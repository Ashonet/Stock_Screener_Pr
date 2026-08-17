/**
 * Tiny in-memory TTL cache with single-flight de-duplication.
 *
 * Two jobs:
 *  - keep us far under Yahoo's rate limits when several browser tabs poll the
 *    same tickers,
 *  - collapse concurrent misses for the same key into one upstream request.
 */

const store = new Map(); // key -> { value, expires }
const inflight = new Map(); // key -> Promise

const MAX_ENTRIES = 500;

function sweep() {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expires <= now) store.delete(key);
  }
  // Bounded memory: if still oversized, drop oldest insertions first.
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

/**
 * Return the cached value for `key`, or produce it with `producer()`.
 * @param {string} key
 * @param {number} ttlMs how long a fresh value stays usable
 * @param {() => Promise<any>} producer
 */
export async function cached(key, ttlMs, producer) {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const value = await producer();
      store.set(key, { value, expires: Date.now() + ttlMs });
      if (store.size > MAX_ENTRIES) sweep();
      return value;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

export function invalidate(prefix = '') {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

export function stats() {
  return { entries: store.size, inflight: inflight.size };
}
