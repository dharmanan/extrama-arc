'use strict';

// Short lived in memory cache for one round result, keyed by slug and round
// ID. A result carries live claim state, so the TTL stays short (15 s).
// Concurrent identical requests share one in flight computation, a failed
// computation is never cached, and the first request after expiry computes
// again. Restarting the process simply empties it. General RPC reads are not
// cached here.

const ROUND_RESULT_CACHE_TTL_MS = 15 * 1000;
const PRUNE_THRESHOLD = 256;

function createPromiseTtlCache({ ttlMs, now = () => Date.now() }) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('cache_ttl_invalid');

  const values = new Map();
  const inFlight = new Map();

  function prune(currentMs) {
    if (values.size < PRUNE_THRESHOLD) return;
    for (const [key, entry] of values) {
      if (entry.expiresAt <= currentMs) values.delete(key);
    }
  }

  function get(key, load) {
    const cached = values.get(key);
    if (cached && cached.expiresAt > now()) return Promise.resolve(cached.value);

    const pending = inFlight.get(key);
    if (pending) return pending;

    const computation = Promise.resolve()
      .then(load)
      .then((value) => {
        const storedAt = now();
        prune(storedAt);
        values.set(key, { value, expiresAt: storedAt + ttlMs });
        return value;
      })
      .finally(() => {
        inFlight.delete(key);
      });

    inFlight.set(key, computation);
    return computation;
  }

  return Object.freeze({
    get,
    size: () => values.size,
    inFlightCount: () => inFlight.size,
  });
}

function createRoundResultCache({ readRoundResult, ttlMs = ROUND_RESULT_CACHE_TTL_MS, now } = {}) {
  if (typeof readRoundResult !== 'function') throw new Error('round_result_reader_required');
  const cache = createPromiseTtlCache({ ttlMs, now });

  return Object.freeze({
    read({ slug, roundId }) {
      return cache.get(`${slug}:${roundId}`, () => readRoundResult({ slug, roundId }));
    },
  });
}

module.exports = {
  ROUND_RESULT_CACHE_TTL_MS,
  createPromiseTtlCache,
  createRoundResultCache,
};
