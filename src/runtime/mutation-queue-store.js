/**
 * Durable offline mutation queue backed by Web Storage.
 * Bodies must remain intact so a later flush can replay entity writes.
 * Sensitive entity types are excluded from the queue by prepareEntityMutation
 * (OFFLINE_QUEUE_BLOCKED), not by stripping fields here.
 */
export function createMutationQueueStore({
  storage,
  storeKey = 'mechpro-mutation-queue-v1',
} = {}) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    throw new TypeError('createMutationQueueStore requires a Web Storage-compatible storage');
  }

  let cache = null;
  let rawCache = null;

  function read() {
    const raw = storage.getItem(storeKey) || '[]';
    if (rawCache === raw && Array.isArray(cache)) return cache;
    rawCache = raw;
    try {
      const parsed = JSON.parse(raw);
      cache = Array.isArray(parsed) ? parsed : [];
    } catch {
      cache = [];
    }
    return cache;
  }

  function write(queue) {
    const next = Array.isArray(queue) ? queue : [];
    const raw = JSON.stringify(next);
    if (raw === rawCache) {
      cache = next;
      return;
    }
    rawCache = raw;
    cache = next;
    storage.setItem(storeKey, raw);
  }

  return { read, write };
}
