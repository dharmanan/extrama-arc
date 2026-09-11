import type { ArchiveResponse } from "./backend-api";

// Archive only stale while revalidate cache. The global API request helper
// stays `no-store` so live data is always fresh; only the last successful
// archive is kept, per tab, so a revisit can render it immediately while a
// fresh read runs in the background. A failed read never replaces it.

const ARCHIVE_CACHE_VERSION = "v1";

export type CachedArchive = {
  archive: ArchiveResponse;
  cachedAt: number;
};

// Survives client side navigation within the tab without touching storage.
const memoryCache = new Map<number, CachedArchive>();

function storageKey(days: number) {
  return `extrema:archive:${ARCHIVE_CACHE_VERSION}:${days}`;
}

function isCachedArchive(value: unknown): value is CachedArchive {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CachedArchive>;
  return (
    typeof candidate.cachedAt === "number" &&
    Boolean(candidate.archive) &&
    typeof candidate.archive === "object" &&
    Array.isArray(candidate.archive.rounds) &&
    Boolean(candidate.archive.chain) &&
    typeof candidate.archive.chain === "object"
  );
}

export function readCachedArchive(days: number): CachedArchive | null {
  const remembered = memoryCache.get(days);
  if (remembered) return remembered;
  if (typeof window === "undefined") return null;

  try {
    const raw = window.sessionStorage.getItem(storageKey(days));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isCachedArchive(parsed)) {
      window.sessionStorage.removeItem(storageKey(days));
      return null;
    }
    memoryCache.set(days, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function writeCachedArchive(days: number, archive: ArchiveResponse) {
  const entry: CachedArchive = { archive, cachedAt: Date.now() };
  memoryCache.set(days, entry);
  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.setItem(storageKey(days), JSON.stringify(entry));
  } catch {
    // Storage full or unavailable: the in memory copy still serves this tab.
  }
}
