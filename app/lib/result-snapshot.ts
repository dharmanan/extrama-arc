import { useSyncExternalStore } from "react";
import type { ArchiveRound } from "./backend-api";

// Historical result snapshot handed from the Archive to a Result page. When a
// reader opens a result from the Archive, the archive round they clicked is
// saved here synchronously, before navigation, so the Result page can render
// that known historical result at once while the authoritative result loads.
// It holds only what the Archive payload already contains; nothing is fetched
// to create it, and it is never treated as authoritative.

const RESULT_SNAPSHOT_VERSION = "v1";

export type HistoricalResultSnapshot = {
  // When the archive payload behind this snapshot was read.
  archiveReadAt: number;
  explorerUrl: string;
  round: ArchiveRound & { roundId: number };
};

const memoryCache = new Map<string, HistoricalResultSnapshot>();
const listeners = new Set<() => void>();

function snapshotKey(slug: string, roundId: number) {
  return `extrema:result-snapshot:${RESULT_SNAPSHOT_VERSION}:${slug}:${roundId}`;
}

function isSnapshot(value: unknown, slug: string, roundId: number): value is HistoricalResultSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HistoricalResultSnapshot>;
  const round = candidate.round as Partial<ArchiveRound> | undefined;
  return (
    typeof candidate.archiveReadAt === "number" &&
    typeof candidate.explorerUrl === "string" &&
    Boolean(round) &&
    typeof round === "object" &&
    round.slug === slug &&
    round.roundId === roundId &&
    Array.isArray(round.winners)
  );
}

export function saveResultSnapshot(round: ArchiveRound, explorerUrl: string, archiveReadAt: number) {
  if (round.roundId === null || !Number.isInteger(round.roundId)) return;
  const snapshot: HistoricalResultSnapshot = {
    archiveReadAt,
    explorerUrl,
    round: { ...round, roundId: round.roundId },
  };
  const key = snapshotKey(round.slug, round.roundId);
  memoryCache.set(key, snapshot);
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(key, JSON.stringify(snapshot));
    } catch {
      // Storage full or unavailable: the in memory copy still serves this tab.
    }
  }
  listeners.forEach((listener) => listener());
}

export function readResultSnapshot(slug: string, roundId: number): HistoricalResultSnapshot | null {
  if (!slug || !Number.isInteger(roundId) || roundId <= 0) return null;
  const key = snapshotKey(slug, roundId);
  const remembered = memoryCache.get(key);
  if (remembered) return remembered;
  if (typeof window === "undefined") return null;

  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isSnapshot(parsed, slug, roundId)) {
      window.sessionStorage.removeItem(key);
      return null;
    }
    memoryCache.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Hydration safe: the server snapshot is always empty.
export function useResultSnapshot(slug: string, roundId: number): HistoricalResultSnapshot | null {
  return useSyncExternalStore(
    subscribe,
    () => readResultSnapshot(slug, roundId),
    () => null,
  );
}
