import { useSyncExternalStore } from "react";
import type { LiveResult } from "../results/[slug]/[roundId]/ResultClient";

// Result page only stale while revalidate cache. A result the reader already
// opened in this tab renders immediately on return while the page fetches it
// again; the fresh payload always replaces it, so this copy is never treated
// as authoritative. The global API request helper stays `no-store`.

const RESULT_CACHE_VERSION = "v1";
// Younger than this, a cached result counts as fresh; older ones still render
// at once, but only as a placeholder for the refresh that is already running.
export const RESULT_CACHE_FRESH_MS = 15 * 1000;

export type CachedResult = {
  result: LiveResult;
  cachedAt: number;
};

const memoryCache = new Map<string, CachedResult>();
const listeners = new Set<() => void>();

function cacheKey(slug: string, roundId: number) {
  return `extrema:result:${RESULT_CACHE_VERSION}:${slug}:${roundId}`;
}

function isCachedResult(value: unknown, slug: string, roundId: number): value is CachedResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CachedResult>;
  const result = candidate.result as Partial<LiveResult> | undefined;
  return (
    typeof candidate.cachedAt === "number" &&
    Boolean(result) &&
    typeof result === "object" &&
    result.pool?.slug === slug &&
    result.round?.roundId === roundId &&
    Array.isArray(result.winners)
  );
}

export function readCachedResult(slug: string, roundId: number): CachedResult | null {
  if (!slug || !Number.isInteger(roundId) || roundId <= 0) return null;
  const key = cacheKey(slug, roundId);
  const remembered = memoryCache.get(key);
  if (remembered) return remembered;
  if (typeof window === "undefined") return null;

  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isCachedResult(parsed, slug, roundId)) {
      window.sessionStorage.removeItem(key);
      return null;
    }
    memoryCache.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function writeCachedResult(result: LiveResult) {
  const slug = result.pool.slug;
  const roundId = result.round.roundId;
  const key = cacheKey(slug, roundId);
  const entry: CachedResult = { result, cachedAt: Date.now() };
  memoryCache.set(key, entry);
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(key, JSON.stringify(entry));
    } catch {
      // Storage full or unavailable: the in memory copy still serves this tab.
    }
  }
  listeners.forEach((listener) => listener());
}

export function isFreshCachedResult(entry: CachedResult, nowMs = Date.now()) {
  return nowMs - entry.cachedAt < RESULT_CACHE_FRESH_MS;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Hydration safe: the server snapshot is always empty, so a cached result
// appears only on the client, after hydration or on client navigation.
export function useCachedResult(slug: string, roundId: number): CachedResult | null {
  return useSyncExternalStore(
    subscribe,
    () => readCachedResult(slug, roundId),
    () => null,
  );
}
